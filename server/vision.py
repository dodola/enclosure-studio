"""Conservative 2D image metrology. Semantic connector recognition is not claimed."""
import base64
import json

import cv2
import numpy as np


def order_corners(points):
    points = np.asarray(points, dtype=np.float32)
    sums = points.sum(axis=1)
    differences = np.diff(points, axis=1).reshape(-1)
    return np.array([points[np.argmin(sums)], points[np.argmin(differences)], points[np.argmax(sums)], points[np.argmax(differences)]], dtype=np.float32)


def analyse(data: bytes, width: float, depth: float, corners_json: str | None):
    image = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("图片无法读取，请使用 PNG、JPEG 或 WebP。")
    ih, iw = image.shape[:2]
    if ih * iw > 30_000_000:
        raise ValueError("图片过大，请将分辨率缩小到 3000 万像素以下。")
    image_scale = min(1, 1800 / max(iw, ih))
    if image_scale < 1:
        image = cv2.resize(image, (round(iw * image_scale), round(ih * image_scale)))
    ih, iw = image.shape[:2]
    manual = bool(corners_json)
    if manual:
        corners_normalised = np.asarray(json.loads(corners_json), dtype=np.float32)
        if corners_normalised.shape != (4, 2) or not np.isfinite(corners_normalised).all() or np.any(corners_normalised < 0) or np.any(corners_normalised > 1):
            raise ValueError("请在图片上标记四个板角。")
        # Preserve the user's chosen width/depth orientation, including rotated photos.
        points = np.asarray(corners_normalised * [iw, ih], dtype=np.float32)
    else:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
        mask = cv2.inRange(gray, 0, 165)
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            raise ValueError("未找到清晰的板轮廓，请手动标记四个板角。")
        contour = max(contours, key=cv2.contourArea)
        if cv2.contourArea(contour) < iw * ih * 0.035:
            raise ValueError("板件在图片中太小，请裁剪后上传或标记四个板角。")
        hull = cv2.convexHull(contour)
        approximate = cv2.approxPolyDP(hull, 0.025 * cv2.arcLength(hull, True), True)
        points = order_corners(approximate.reshape(4, 2) if len(approximate) == 4 else cv2.boxPoints(cv2.minAreaRect(hull)))
    if len(np.unique(points, axis=0)) != 4 or not cv2.isContourConvex(points) or cv2.contourArea(points) < iw * ih * 0.01:
        raise ValueError("四个板角不能重叠或共线，请重新标记。")
    density = min(8, 1400 / max(width, depth))
    ow, oh = max(24, round(width * density)), max(24, round(depth * density))
    transform = cv2.getPerspectiveTransform(points, np.float32([[0, 0], [ow - 1, 0], [ow - 1, oh - 1], [0, oh - 1]]))
    rectified = cv2.warpPerspective(image, transform, (ow, oh))
    gray = cv2.cvtColor(rectified, cv2.COLOR_BGR2GRAY)
    circles = cv2.HoughCircles(cv2.GaussianBlur(gray, (5, 5), 1), cv2.HOUGH_GRADIENT, dp=1,
                              minDist=5 * density, param1=90, param2=25,
                              minRadius=max(3, round(1.1 * density)), maxRadius=max(4, round(2.8 * density)))
    candidates = []
    if circles is not None:
        for x, y, r in circles[0]:
            x, y, r = float(x), float(y), float(r)
            radius = max(1, int(r * 0.5))
            sample = gray[max(0, int(y) - radius): min(oh, int(y) + radius), max(0, int(x) - radius): min(ow, int(x) + radius)]
            if sample.size == 0 or sample.mean() < 170:
                continue
            mx, my = x / (ow - 1) * width, y / (oh - 1) * depth
            if min(mx, width - mx, my, depth - my) > 22:
                continue
            candidates.append(dict(id=f"detected-{len(candidates)}", x=round(mx, 2), y=round(my, 2),
                                   diameter=round(2 * r / density, 2), source="image", verified=False))
    candidates.sort(key=lambda h: (round(h["y"] / 5), h["x"]))
    _, encoded = cv2.imencode('.jpg', rectified, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return dict(corners=(points / [iw, ih]).tolist(), holes=candidates[:24],
                rectifiedImage="data:image/jpeg;base64," + base64.b64encode(encoded).decode(),
                method="四角透视校准" if manual else "自动轮廓初估", needsReview=True,
                note="圆孔候选可能包含散热器孔，需逐个确认用途。孔径是图像估算；照片不能确定接口高度。",
                width=width, depth=depth)
