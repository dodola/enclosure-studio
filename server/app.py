import csv
import io
import json
import os
import zipfile
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .geometry import build, mounting_coupon, printable_lid, serialise
from .models import Project, validate_design
from .vision import analyse

app = FastAPI(title="壳研 Enclosure Studio", version="0.1.0")


@app.get("/api/health")
def health():
    return {"status": "ok", "vision": "opencv", "geometry": "manifold"}


@app.api_route("/api/ai/{path:path}", methods=["GET", "POST"])
async def ai_proxy(path: str, request: Request):
    """Keep the Pi SDK in Node; serve a single same-origin API in dev and production."""
    import httpx
    if (request.method, path) not in {("GET", "config"), ("POST", "annotate"), ("POST", "chat"), ("POST", "settings"), ("POST", "test")}:
        raise HTTPException(404, "AI 接口不存在。")
    if path in {"settings", "test"}:
        from urllib.parse import urlparse
        origin = request.headers.get("origin")
        if request.headers.get("sec-fetch-site") == "cross-site" or (origin and urlparse(origin).netloc != request.headers.get("host")):
            raise HTTPException(403, "AI 设置只接受同源请求。")
        if not request.headers.get("content-type", "").startswith("application/json"):
            raise HTTPException(415, "请使用 JSON 请求。")
    body = await request.body()
    if len(body) > (16384 if path in {"settings", "test"} else 20 * 1024 * 1024):
        raise HTTPException(413, "请求体过大。")
    client = httpx.AsyncClient(timeout=httpx.Timeout(190, connect=5))
    try:
        upstream = await client.send(client.build_request(request.method,
            f"http://127.0.0.1:{os.environ.get('PI_PORT', '8012')}/api/ai/{path}",
            content=body, headers={"Content-Type": "application/json"}), stream=True)
    except httpx.HTTPError as exc:
        await client.aclose()
        raise HTTPException(503, "Pi AI 服务未启动，请运行 npm run dev 或 npm start。") from exc

    async def stream():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(stream(), status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@app.post("/api/analyze")
async def analyze(image: UploadFile = File(...), width: float = Form(...), depth: float = Form(...), corners: str | None = Form(None)):
    if not 3 <= width <= 400 or not 3 <= depth <= 400:
        raise HTTPException(422, "长宽必须在 3–400 mm 之间。")
    data = await image.read(12 * 1024 * 1024 + 1)
    if len(data) > 12 * 1024 * 1024:
        raise HTTPException(413, "图片不能超过 12 MB。")
    try:
        # Run CPU-heavy image processing off the event loop.
        from starlette.concurrency import run_in_threadpool
        return await run_in_threadpool(analyse, data, width, depth, corners)
    except (ValueError, json.JSONDecodeError, cv2_error()) as exc:
        raise HTTPException(422, str(exc)) from exc


def cv2_error():
    import cv2
    return cv2.error


@app.post("/api/validate")
def validate(project: Project):
    return {"issues": validate_design(project)}


@app.post("/api/preview")
def preview(project: Project):
    try:
        base, lid, issues = build(project)
        return {"base": serialise(base), "lid": serialise(lid), "issues": issues}
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/export")
def export(project: Project):
    try:
        base, lid, issues = build(project)
        csv_buffer = io.StringIO()
        writer = csv.writer(csv_buffer)
        writer.writerow(["component", "feature", "x_mm", "y_mm", "diameter_mm", "source", "verified"])
        for c in project.components:
            for h in c.holes:
                writer.writerow([c.name, h.id, h.x, h.y, h.diameter, h.source, h.verified])
        manifest = project.model_dump()
        manifest["issues"] = issues
        manifest["units"] = "mm"
        manifest["printOrientation"] = {"base.stl": "底板朝下", "lid.stl": "外表面朝下、定位边朝上"}
        notes = ["# 壳研 · 打印说明", "", f"项目：{project.name}", "", "所有模型单位为毫米。", "base.stl 底板朝下；lid.stl 已翻转至平面外表面朝下。", "外壳角部为螺丝导孔，不含打印螺纹；请按实际螺丝选用长度。", "当前模型为矩形两片式外壳，未包含线缆、散热器和卡扣。", "请先试打印 mounting-test.stl 验证孔位，再检查接口插拔。", "", "## 待复核事项", ""]
        notes.extend(f"- {i['message']}" for i in issues)
        if not issues:
            notes.append("- 软件几何检查通过；装配精度仍需实物试装验证。")
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("base.stl", base.export(file_type="stl"))
            archive.writestr("lid.stl", printable_lid(lid).export(file_type="stl"))
            archive.writestr("assembly.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            archive.writestr("measurements.csv", "\ufeff" + csv_buffer.getvalue())
            archive.writestr("README.md", "\n".join(notes))
            if any(c.mount == "base" and c.holes for c in project.components):
                archive.writestr("mounting-test.stl", mounting_coupon(project).export(file_type="stl"))
        return Response(output.getvalue(), media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="enclosure-kit.zip"'})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@app.post("/api/coupon")
def coupon(project: Project):
    errors = [i for i in validate_design(project) if i["severity"] == "error"]
    if errors:
        raise HTTPException(422, "请先修正设计中的几何错误。")
    try:
        return Response(mounting_coupon(project).export(file_type="stl"), media_type="model/stl", headers={"Content-Disposition": 'attachment; filename="mounting-test.stl"'})
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


DIST = Path(__file__).resolve().parent.parent / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}")
    def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, "API 不存在。")
        candidate = (DIST / path).resolve()
        if candidate.is_relative_to(DIST) and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
