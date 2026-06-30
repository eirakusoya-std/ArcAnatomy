from __future__ import annotations

from datetime import datetime, timezone
import json
import math
from typing import Any


Point = dict[str, float]


DEFAULT_RECONSTRUCTION_SETTINGS: dict[str, Any] = {
    "targetArcCount": 14,
    "arcMergeAggressiveness": 58,
    "visibleParentCircleLimit": 6,
    "minFittedRadius": 5,
    "maxFittedRadius": 520,
    "duplicateCenterTolerance": 18,
    "duplicateRadiusTolerance": 0.12,
    "loopClosureTolerance": 14,
    "minLoopInsideScore": 0.35,
    "minLoopArea": 24,
    "arcSampleSpacing": 5,
    "enableArcGroupMerging": True,
    "maxMergeGroupSize": 4,
    "tangentMergeThreshold": 24,
    "refitErrorThreshold": 5.4,
    "errorIncreaseThreshold": 1.8,
    "simplicityWeight": 0.72,
    "tangentWeight": 0.52,
    "errorWeight": 0.64,
}


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def normalize_angle(angle: float) -> float:
    return angle % 360


def angle_span(start: float, end: float) -> float:
    span = normalize_angle(end - start)
    return 360 if span == 0 else span


def angle_in_arc(angle: float, start: float, end: float) -> bool:
    return normalize_angle(angle - start) <= angle_span(start, end) + 0.5


def point_angle_from_center(point: Point, cx: float, cy: float) -> float:
    return normalize_angle(math.degrees(math.atan2(point["y"] - cy, point["x"] - cx)))


def image_data_to_analysis(image_data: dict[str, Any], threshold: float, blur_radius: float, edge_strength: float) -> dict[str, Any]:
    width = int(image_data["width"])
    height = int(image_data["height"])
    data = image_data["data"]
    gray = [0.0] * (width * height)

    for i in range(width * height):
        r = data[i * 4]
        g = data[i * 4 + 1]
        b = data[i * 4 + 2]
        a = data[i * 4 + 3] / 255
        luminance = 0.299 * r + 0.587 * g + 0.114 * b
        gray[i] = 255 - (luminance * a + 255 * (1 - a))

    blurred = box_blur(gray, width, height, blur_radius)
    mask = [1 if value >= threshold else 0 for value in blurred]
    cleaned_lines = majority_filter(mask, width, height, edge_strength)
    cleaned = fill_line_art_if_needed(cleaned_lines, width, height)
    edge = extract_edges(cleaned, width, height)
    contour_loops = extract_contour_loops(cleaned, width, height, edge_strength)
    primary_loop = contour_loops[0] if contour_loops else None
    raw_contour_points = primary_loop["points"] if primary_loop else extract_outer_contour(cleaned, edge, width, height)
    smoothed_contour_points = smooth_closed_points(raw_contour_points, max(2, round(3 + edge_strength)))
    contour_points = primary_loop["points"] if primary_loop else resample_closed_polyline(
        smoothed_contour_points,
        max(3, round(math.hypot(width, height) / 240)),
    )
    contour_segments = primary_loop["segments"] if primary_loop else split_contour_segments(contour_points)
    stats = compute_stats(cleaned, width, height)
    return {
        "width": width,
        "height": height,
        "mask": cleaned,
        "edge": edge,
        "contourLoops": contour_loops,
        "rawContourPoints": raw_contour_points,
        "smoothedContourPoints": smoothed_contour_points,
        "contourSegments": contour_segments,
        "contourPoints": contour_points,
        "centroid": stats["centroid"],
        "bounds": stats["bounds"],
    }


def extract_contour_loops(mask: list[int], width: int, height: int, edge_strength: float) -> list[dict[str, Any]]:
    components = sorted(
        [component for component in connected_components(mask, width, height) if len(component["pixels"]) >= 24],
        key=lambda component: len(component["pixels"]),
        reverse=True,
    )
    spacing = max(3, round(math.hypot(width, height) / 240))
    loops: list[dict[str, Any]] = []
    for index, component in enumerate(components):
        component_mask = [0] * len(mask)
        for pixel in component["pixels"]:
            component_mask[pixel] = 1
        component_edge = extract_edges(component_mask, width, height)
        raw = extract_outer_contour(component_mask, component_edge, width, height)
        smoothed = smooth_closed_points(raw, max(2, round(3 + edge_strength)))
        points = resample_closed_polyline(smoothed, spacing)
        loops.append({
            "id": f"component-{index + 1}",
            "points": points,
            "segments": split_contour_segments(points),
            "bounds": component["bounds"],
            "area": len(component["pixels"]),
        })
    return loops


def connected_components(mask: list[int], width: int, height: int) -> list[dict[str, Any]]:
    visited = [0] * len(mask)
    components: list[dict[str, Any]] = []
    neighbors = [(1, 0), (-1, 0), (0, 1), (0, -1)]
    for i, value in enumerate(mask):
        if not value or visited[i]:
            continue
        queue = [i]
        pixels: list[int] = []
        visited[i] = 1
        min_x = max_x = i % width
        min_y = max_y = i // width
        head = 0
        while head < len(queue):
            pixel = queue[head]
            head += 1
            pixels.append(pixel)
            x = pixel % width
            y = pixel // width
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)
            for ox, oy in neighbors:
                nx = x + ox
                ny = y + oy
                if nx < 0 or nx >= width or ny < 0 or ny >= height:
                    continue
                next_i = ny * width + nx
                if not mask[next_i] or visited[next_i]:
                    continue
                visited[next_i] = 1
                queue.append(next_i)
        components.append({"pixels": pixels, "bounds": {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y}})
    return components


def fill_line_art_if_needed(mask: list[int], width: int, height: int) -> list[int]:
    stats = compute_stats(mask, width, height)
    bounds = stats["bounds"]
    bounds_area = max(1, (bounds["maxX"] - bounds["minX"] + 1) * (bounds["maxY"] - bounds["minY"] + 1))
    density = sum(mask) / bounds_area
    if density > 0.18:
        return mask

    outside = [0] * len(mask)
    queue: list[int] = []

    def push(x: int, y: int) -> None:
        i = y * width + x
        if outside[i] or mask[i]:
            return
        outside[i] = 1
        queue.append(i)

    for x in range(width):
        push(x, 0)
        push(x, height - 1)
    for y in range(height):
        push(0, y)
        push(width - 1, y)

    head = 0
    while head < len(queue):
        i = queue[head]
        head += 1
        x = i % width
        y = i // width
        if x > 0:
            push(x - 1, y)
        if x < width - 1:
            push(x + 1, y)
        if y > 0:
            push(x, y - 1)
        if y < height - 1:
            push(x, y + 1)

    filled = [1 if mask[i] or not outside[i] else 0 for i in range(len(mask))]
    return majority_filter(filled, width, height, 1)


def box_blur(src: list[float], width: int, height: int, radius: float) -> list[float]:
    r = round(radius)
    if r <= 0:
        return src
    dst = [0.0] * len(src)
    area = (r * 2 + 1) * (r * 2 + 1)
    for y in range(height):
        for x in range(width):
            total = 0.0
            for yy in range(-r, r + 1):
                for xx in range(-r, r + 1):
                    sx = int(clamp(x + xx, 0, width - 1))
                    sy = int(clamp(y + yy, 0, height - 1))
                    total += src[sy * width + sx]
            dst[y * width + x] = total / area
    return dst


def majority_filter(mask: list[int], width: int, height: int, passes: float) -> list[int]:
    current = mask
    for _ in range(max(1, round(passes))):
        next_mask = [0] * len(current)
        for y in range(height):
            for x in range(width):
                neighbors = 0
                for yy in range(-1, 2):
                    for xx in range(-1, 2):
                        sx = x + xx
                        sy = y + yy
                        if 0 <= sx < width and 0 <= sy < height:
                            neighbors += current[sy * width + sx]
                next_mask[y * width + x] = 1 if neighbors >= 5 else 0
        current = next_mask
    return current


def extract_edges(mask: list[int], width: int, height: int) -> list[int]:
    edge = [0] * len(mask)
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            i = y * width + x
            if mask[i] and (not mask[i - 1] or not mask[i + 1] or not mask[i - width] or not mask[i + width]):
                edge[i] = 1
    return edge


def sample_contour(edge: list[int], width: int, height: int, step: int) -> list[Point]:
    points: list[Point] = []
    for y in range(0, height, step):
        for x in range(0, width, step):
            if edge[y * width + x]:
                points.append({"x": x, "y": y})
    return points


def extract_outer_contour(mask: list[int], edge: list[int], width: int, height: int) -> list[Point]:
    start = find_top_left_edge(edge, width, height)
    if not start:
        return sample_contour(edge, width, height, 1)
    directions = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
    contour: list[Point] = []
    current = start
    previous_direction = 4
    for step in range(width * height):
        contour.append({"x": current["x"], "y": current["y"]})
        found = None
        found_direction = previous_direction
        for offset in range(len(directions)):
            direction_index = (previous_direction + 6 + offset) % len(directions)
            dx, dy = directions[direction_index]
            next_point = {"x": current["x"] + dx, "y": current["y"] + dy}
            if next_point["x"] <= 0 or next_point["x"] >= width - 1 or next_point["y"] <= 0 or next_point["y"] >= height - 1:
                continue
            if not edge[int(next_point["y"]) * width + int(next_point["x"])]:
                continue
            found = next_point
            found_direction = direction_index
            break
        if not found:
            break
        current = found
        previous_direction = found_direction
        if step > 12 and current["x"] == start["x"] and current["y"] == start["y"]:
            break
    if len(contour) < 16:
        return order_edge_points(sample_contour(edge, width, height, 1))
    return remove_near_duplicate_points(contour)


def find_top_left_edge(edge: list[int], width: int, height: int) -> Point | None:
    for y in range(1, height - 1):
        for x in range(1, width - 1):
            if edge[y * width + x]:
                return {"x": x, "y": y}
    return None


def order_edge_points(points: list[Point]) -> list[Point]:
    if len(points) < 3:
        return points
    remaining = points[:]
    ordered = [remaining.pop(0)]
    while remaining:
        current = ordered[-1]
        best_index = min(range(len(remaining)), key=lambda i: math.hypot(current["x"] - remaining[i]["x"], current["y"] - remaining[i]["y"]))
        ordered.append(remaining.pop(best_index))
    return ordered


def smooth_closed_points(points: list[Point], radius: int) -> list[Point]:
    if len(points) < 3:
        return points
    out: list[Point] = []
    r = max(1, radius)
    for i in range(len(points)):
        sum_x = 0.0
        sum_y = 0.0
        count = 0
        for offset in range(-r, r + 1):
            point = points[(i + offset + len(points)) % len(points)]
            sum_x += point["x"]
            sum_y += point["y"]
            count += 1
        out.append({"x": sum_x / count, "y": sum_y / count})
    return out


def resample_closed_polyline(points: list[Point], spacing: float) -> list[Point]:
    if len(points) < 2:
        return points
    closed = points + [points[0]]
    distances = [0.0]
    for i in range(1, len(closed)):
        distances.append(distances[i - 1] + math.hypot(closed[i]["x"] - closed[i - 1]["x"], closed[i]["y"] - closed[i - 1]["y"]))
    total = distances[-1]
    count = max(24, round(total / max(1, spacing)))
    out: list[Point] = []
    for sample in range(count):
        target = (sample / count) * total
        segment = 1
        while segment < len(distances) - 1 and distances[segment] < target:
            segment += 1
        prev_distance = distances[segment - 1]
        next_distance = distances[segment]
        t = 0 if next_distance == prev_distance else (target - prev_distance) / (next_distance - prev_distance)
        a = closed[segment - 1]
        b = closed[segment]
        out.append({"x": a["x"] + (b["x"] - a["x"]) * t, "y": a["y"] + (b["y"] - a["y"]) * t})
    return out


def split_contour_segments(points: list[Point]) -> list[list[int]]:
    if len(points) < 12:
        return [[index for index, _ in enumerate(points)]]
    curvature: list[float] = []
    for index, current in enumerate(points):
        prev = points[(index - 3 + len(points)) % len(points)]
        next_point = points[(index + 3) % len(points)]
        a = math.atan2(current["y"] - prev["y"], current["x"] - prev["x"])
        b = math.atan2(next_point["y"] - current["y"], next_point["x"] - current["x"])
        curvature.append(abs(normalize_radians(b - a)))
    sorted_curvature = sorted(curvature)
    threshold = max(0.32, sorted_curvature[math.floor(len(sorted_curvature) * 0.82)] if sorted_curvature else 0.32)
    breaks = [item["index"] for item in sorted(
        [{"value": value, "index": index} for index, value in enumerate(curvature) if value >= threshold],
        key=lambda item: item["value"],
        reverse=True,
    )]
    min_gap = max(8, round(len(points) / 18))
    picked: list[int] = []
    for index in breaks:
        if all(circular_index_distance(index, other, len(points)) >= min_gap for other in picked):
            picked.append(index)
        if len(picked) >= 10:
            break
    if len(picked) < 2:
        return [[index for index, _ in enumerate(points)]]
    picked.sort()
    segments: list[list[int]] = []
    for i, start in enumerate(picked):
        end = picked[(i + 1) % len(picked)]
        segment: list[int] = []
        cursor = start
        while cursor != end:
            segment.append(cursor)
            cursor = (cursor + 1) % len(points)
            if len(segment) > len(points):
                break
        if len(segment) >= 6:
            segments.append(segment)
    return segments or [[index for index, _ in enumerate(points)]]


def remove_near_duplicate_points(points: list[Point]) -> list[Point]:
    return [
        point for index, point in enumerate(points)
        if math.hypot(point["x"] - points[(index - 1 + len(points)) % len(points)]["x"], point["y"] - points[(index - 1 + len(points)) % len(points)]["y"]) > 0.5
    ]


def circular_index_distance(a: int, b: int, length: int) -> int:
    distance = abs(a - b)
    return min(distance, length - distance)


def normalize_radians(value: float) -> float:
    angle = value
    while angle > math.pi:
        angle -= math.pi * 2
    while angle < -math.pi:
        angle += math.pi * 2
    return angle


def compute_stats(mask: list[int], width: int, height: int) -> dict[str, Any]:
    sum_x = 0.0
    sum_y = 0.0
    count = 0
    min_x = width
    min_y = height
    max_x = 0
    max_y = 0
    for y in range(height):
        for x in range(width):
            if not mask[y * width + x]:
                continue
            sum_x += x
            sum_y += y
            count += 1
            min_x = min(min_x, x)
            min_y = min(min_y, y)
            max_x = max(max_x, x)
            max_y = max(max_y, y)
    if count == 0:
        return {
            "centroid": {"x": width / 2, "y": height / 2},
            "bounds": {"minX": width * 0.25, "minY": height * 0.25, "maxX": width * 0.75, "maxY": height * 0.75},
        }
    return {"centroid": {"x": sum_x / count, "y": sum_y / count}, "bounds": {"minX": min_x, "minY": min_y, "maxX": max_x, "maxY": max_y}}


def build_construction(analysis: dict[str, Any], circles: list[dict[str, Any]] | None = None, settings: dict[str, Any] | None = None) -> dict[str, Any]:
    merged_settings = {**DEFAULT_RECONSTRUCTION_SETTINGS, **(settings or {})}
    contour_chain = build_contour_ordered_arc_chain(analysis, circles or [], merged_settings)
    selected_loop_ids = [face["id"] for face in contour_chain["faces"] if face["selected"]]
    expression = f"Fill inside closed circular arc loops: {', '.join(selected_loop_ids)}" if selected_loop_ids else "No closed circular arc loop selected."
    return {
        "width": analysis["width"],
        "height": analysis["height"],
        "circles": contour_chain["circles"],
        "arcs": contour_chain["arcs"],
        "finalShape": {
            "type": "arc_loop_fill",
            "expression": "selected circular arcs -> closed arc loops -> fill inside loops",
            "loopIds": selected_loop_ids,
        },
        "intersections": contour_chain["intersections"],
        "splitArcPieces": contour_chain["splitArcPieces"],
        "graphNodes": contour_chain["graphNodes"],
        "graphEdges": contour_chain["graphEdges"],
        "faces": contour_chain["faces"],
        "faceDebug": contour_chain["faceDebug"],
        "arcGroupMergeDebug": contour_chain["arcGroupMergeDebug"],
        "mergedArcInfo": contour_chain["mergedArcInfo"],
        "conditions": [],
        "expression": expression,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def build_contour_ordered_arc_chain(analysis: dict[str, Any], helper_circles: list[dict[str, Any]], settings: dict[str, Any]) -> dict[str, Any]:
    contour_circles: list[dict[str, Any]] = []
    arcs: list[dict[str, Any]] = []
    split_arc_pieces: list[dict[str, Any]] = []
    graph_nodes: list[dict[str, Any]] = []
    graph_edges: list[dict[str, Any]] = []
    faces: list[dict[str, Any]] = []
    arc_group_merge_debug: list[dict[str, Any]] = []
    merged_arc_info: list[dict[str, Any]] = []
    raw_candidates_count = 0
    suppressed_candidates = 0
    merged_clusters = 0
    source_loops = analysis["contourLoops"] or [{
        "id": "component-1",
        "points": analysis["contourPoints"],
        "segments": analysis["contourSegments"],
        "bounds": analysis["bounds"],
        "area": sum(analysis["mask"]),
    }]
    for loop_index, loop in enumerate(source_loops):
        prefix = f"L{loop_index + 1}"
        segments = make_contour_arc_segments(loop["points"], loop["segments"], settings)
        raw_candidates = fit_contour_arc_candidates(loop["points"], segments, settings)
        redundant_merged_candidates = merge_redundant_contour_candidates(loop["points"], raw_candidates, settings)
        group_merge = merge_smooth_arc_groups(loop["points"], redundant_merged_candidates, settings, loop_index + 1)
        merged_candidates = group_merge["candidates"]
        raw_candidates_count += len(raw_candidates)
        suppressed_candidates += len(raw_candidates) - len(merged_candidates)
        merged_clusters += len([candidate for candidate in merged_candidates if candidate["memberCount"] > 1])
        arc_group_merge_debug.extend(group_merge["debug"])
        arc_pieces: list[dict[str, Any]] = []
        for segment_index, candidate in enumerate(merged_candidates):
            indices = candidate["indices"]
            points = candidate["points"]
            fit = candidate["fit"]
            member_count = candidate["memberCount"]
            start_point = points[0]
            end_point = points[-1]
            start_angle = point_angle_from_center(start_point, fit["cx"], fit["cy"])
            end_angle = point_angle_from_center(end_point, fit["cx"], fit["cy"])
            middle_angle = point_angle_from_center(points[len(points) // 2], fit["cx"], fit["cy"])
            direction = "ccw" if angle_in_arc(middle_angle, start_angle, end_angle) else "cw"
            span = angle_span(start_angle, end_angle) if direction == "ccw" else angle_span(end_angle, start_angle)
            arc_length = (span / 360) * math.pi * 2 * fit["r"]
            contour_support = len(points) / max(1, len(loop["points"]))
            circle_id = f"OC{loop_index + 1}-{segment_index + 1}"
            arc_id = f"OA{loop_index + 1}-{segment_index + 1}"
            piece_id = f"OP{loop_index + 1}-{segment_index + 1}"
            circle = {
                "id": circle_id,
                "cx": fit["cx"],
                "cy": fit["cy"],
                "r": fit["r"],
                "centerX": fit["cx"],
                "centerY": fit["cy"],
                "radius": fit["r"],
                "role": "boundary",
                "visible": True,
                "usedInFinal": True,
                "startAngle": start_angle,
                "endAngle": end_angle,
                "boundarySupport": contour_support,
                "arcLength": arc_length,
                "fitError": fit["error"],
                "contourSupport": contour_support,
                "coveredContourIndices": indices,
                "maskCoverage": 0,
                "outsidePenalty": fit["error"],
                "score": max(0, 1 - fit["error"] / max(1, fit["r"])) + member_count * 0.02,
                "source": "contour_fit",
                "candidateKind": "arc",
                "selectedStep": segment_index + 1,
                "equation": f"(x - {fit['cx']:.1f})^2 + (y - {fit['cy']:.1f})^2 = {fit['r']:.1f}^2",
            }
            contour_circles.append(circle)
            arcs.append({"id": arc_id, "circleId": circle_id, "startAngle": start_angle, "endAngle": end_angle, "usedInSilhouette": True, "usedAsHelperOnly": False})
            if candidate.get("mergeInfo"):
                merge_info = candidate["mergeInfo"]
                merged_arc_info.append({
                    "newArcId": arc_id,
                    "mergedFromArcIds": candidate["sourceCandidateIds"],
                    "centerX": fit["cx"],
                    "centerY": fit["cy"],
                    "radius": fit["r"],
                    "startAngle": start_angle,
                    "endAngle": end_angle,
                    "direction": direction,
                    "fitError": fit["error"],
                    "arcLength": arc_length,
                    "originalError": merge_info["originalError"],
                    "refitError": merge_info["refitError"],
                    "tangentDeltaStats": merge_info["tangentDeltaStats"],
                    "simplicityGain": merge_info["simplicityGain"],
                    "mergeReason": merge_info["mergeReason"],
                })
            start_node = f"{prefix}-N{segment_index + 1}"
            end_node = f"{prefix}-N{((segment_index + 1) % len(segments)) + 1}"
            segment = {
                "id": piece_id,
                "circleId": circle_id,
                "cx": fit["cx"],
                "cy": fit["cy"],
                "r": fit["r"],
                "startAngle": start_angle,
                "endAngle": end_angle,
                "startPoint": start_point,
                "endPoint": end_point,
                "direction": direction,
                "contourSupport": contour_support,
                "fitError": fit["error"],
            }
            sampled_points = sample_arc_loop_segment(segment, settings["arcSampleSpacing"])
            piece = {
                "id": piece_id,
                "parentArcId": arc_id,
                "parentCircleId": circle_id,
                "sourceArcId": arc_id,
                "startNode": start_node,
                "endNode": end_node,
                "startPoint": start_point,
                "endPoint": end_point,
                "startAngle": start_angle,
                "endAngle": end_angle,
                "midpoint": sampled_points[len(sampled_points) // 2],
                "length": polyline_length(sampled_points),
                "selectedAsBoundary": True,
                "points": sampled_points,
            }
            split_arc_pieces.append(piece)
            graph_edges.append({"id": f"{prefix}-E{segment_index + 1}", "startNode": start_node, "endNode": end_node, "sourceArcId": arc_id, "sourcePieceId": piece_id, "direction": direction, "points": sampled_points})
            arc_pieces.append(segment)

        for i, segment in enumerate(segments):
            point = loop["points"][segment[0] if segment else 0] if loop["points"] else {"x": 0, "y": 0}
            graph_nodes.append({
                "id": f"{prefix}-N{i + 1}",
                "x": point["x"],
                "y": point["y"],
                "incidentEdges": [f"{prefix}-E{((i - 1 + len(segments)) % len(segments)) + 1}", f"{prefix}-E{i + 1}"],
            })

        polygon: list[Point] = []
        for index, piece in enumerate(arc_pieces):
            points = sample_arc_loop_segment(piece, settings["arcSampleSpacing"])
            polygon.extend(points if index == 0 else points[1:])
        signed_area = polygon_area(polygon) if len(polygon) >= 3 else 0
        area = abs(signed_area)
        centroid = polygon_centroid(polygon) if len(polygon) >= 3 else analysis["centroid"]
        inside_mask_score = sample_face_inside_mask(analysis, polygon, centroid)
        closure_gap = (
            math.hypot(arc_pieces[0]["startPoint"]["x"] - arc_pieces[-1]["endPoint"]["x"], arc_pieces[0]["startPoint"]["y"] - arc_pieces[-1]["endPoint"]["y"])
            if len(arc_pieces) > 1 else math.inf
        )
        rejection_reason = None
        if len(arc_pieces) < 3:
            rejection_reason = "invalid_loop"
        elif closure_gap > settings["loopClosureTolerance"]:
            rejection_reason = "invalid_loop"
        elif area <= settings["minLoopArea"]:
            rejection_reason = "tiny_face_noise"
        elif inside_mask_score < settings["minLoopInsideScore"]:
            rejection_reason = "low_inside_mask_score"
        faces.append({
            "id": f"contour-loop-{loop_index + 1}",
            "source": "vector_loop",
            "edgeIds": [piece["id"] for piece in arc_pieces],
            "arcPieces": arc_pieces,
            "polygon": polygon,
            "samplePoints": sample_face_points(polygon, centroid),
            "area": area,
            "centroid": centroid,
            "numEdges": len(arc_pieces),
            "insideMaskScore": inside_mask_score,
            "winding": "ccw" if signed_area >= 0 else "cw",
            "nestingDepth": 0,
            "selected": rejection_reason is None,
            **({"rejectionReason": rejection_reason} if rejection_reason else {}),
        })
    assign_face_nesting(faces)
    helper_only_circles = [{**circle, "role": "helper" if circle.get("role") == "candidate" else circle.get("role"), "usedInFinal": False, "visible": False} for circle in helper_circles]
    face_debug = {
        "totalArcPieces": len(split_arc_pieces),
        "validBoundaryArcPieces": len(split_arc_pieces),
        "graphNodesCount": len(graph_nodes),
        "graphEdgesCount": len(graph_edges),
        "closedLoopsCount": len(faces),
        "faceCandidatesCount": len(faces),
        "selectedFacesCount": len([face for face in faces if face["selected"]]),
        "rawCandidatesCount": raw_candidates_count,
        "candidatesAfterNms": len(split_arc_pieces),
        "selectedBeforeClustering": raw_candidates_count,
        "selectedAfterClustering": len(split_arc_pieces),
        "suppressedCandidates": suppressed_candidates,
        "mergedClusters": merged_clusters,
        "fallbackUsed": False,
        **({} if any(face["selected"] for face in faces) else {"emptyReason": "mask_sampling_failed"}),
    }
    visible_circles = suppress_near_duplicate_circle_visibility(contour_circles + helper_only_circles, settings)
    return {
        "circles": visible_circles,
        "arcs": arcs,
        "intersections": [],
        "splitArcPieces": split_arc_pieces,
        "graphNodes": graph_nodes,
        "graphEdges": graph_edges,
        "faces": faces,
        "faceDebug": face_debug,
        "arcGroupMergeDebug": arc_group_merge_debug,
        "mergedArcInfo": merged_arc_info,
    }


def make_contour_arc_segments(contour: list[Point], contour_segments: list[list[int]], settings: dict[str, Any]) -> list[list[int]]:
    if len(contour) < 12:
        return [[index for index, _ in enumerate(contour)]]
    merge_factor = 1 + (settings["arcMergeAggressiveness"] - 50) / 180
    target_segment_count = max(4, min(36, round(settings["targetArcCount"] / merge_factor)))
    base_segments = contour_segments if len(contour_segments) >= 6 else chunk_contour_indices(len(contour), target_segment_count)
    out: list[list[int]] = []
    max_segment_length = max(5, round(len(contour) / target_segment_count))
    for segment in base_segments:
        if len(segment) <= max_segment_length:
            out.append(segment)
            continue
        chunks = math.ceil(len(segment) / max_segment_length)
        size = math.ceil(len(segment) / chunks)
        for i in range(0, len(segment), size):
            chunk = segment[i:i + size]
            if len(chunk) >= 4:
                out.append(chunk)
    return out if len(out) >= 6 else chunk_contour_indices(len(contour), target_segment_count)


def fit_contour_arc_candidates(contour: list[Point], segments: list[list[int]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for index, indices in enumerate(segments):
        points = points_for_contour_segment(contour, indices)
        if len(points) < 3:
            continue
        fit = fit_circle_to_points(points) or fallback_circle_for_points(points)
        radius_filtered_fit = fit if settings["minFittedRadius"] <= fit["r"] <= settings["maxFittedRadius"] else fallback_circle_for_points(points)
        candidates.append({
            "indices": indices,
            "points": points,
            "fit": radius_filtered_fit,
            "memberCount": 1,
            "sourceCandidateIds": [f"raw-arc-{index + 1}"],
        })
    return candidates


def merge_redundant_contour_candidates(contour: list[Point], candidates: list[dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    current = candidates
    changed = True
    while changed:
        changed = False
        merged: list[dict[str, Any]] = []
        i = 0
        while i < len(current):
            a = current[i]
            b = current[i + 1] if i + 1 < len(current) else None
            if b:
                candidate = try_merge_contour_candidates(contour, a, b, settings)
                if candidate:
                    merged.append(candidate)
                    i += 2
                    changed = True
                    continue
            merged.append(a)
            i += 1
        current = merged
    return current


def try_merge_contour_candidates(contour: list[Point], a: dict[str, Any], b: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any] | None:
    if not are_redundant_contour_fits(a["fit"], b["fit"], settings):
        return None
    indices = merge_contour_indices(a["indices"], b["indices"], len(contour))
    points = points_for_contour_segment(contour, indices)
    fit = fit_circle_to_points(points) or fallback_circle_for_points(points)
    previous_error = max(a["fit"]["error"], b["fit"]["error"])
    merge_factor = 1.25 + (settings["arcMergeAggressiveness"] / 100) * 1.35
    allowed_error = max(0.85, previous_error * merge_factor)
    if fit["error"] > allowed_error:
        return None
    return {
        "indices": indices,
        "points": points,
        "fit": fit,
        "memberCount": a["memberCount"] + b["memberCount"],
        "sourceCandidateIds": a["sourceCandidateIds"] + b["sourceCandidateIds"],
        **({"mergeInfo": a.get("mergeInfo") or b.get("mergeInfo")} if a.get("mergeInfo") or b.get("mergeInfo") else {}),
    }


def merge_smooth_arc_groups(contour: list[Point], candidates: list[dict[str, Any]], settings: dict[str, Any], loop_number: int) -> dict[str, Any]:
    if not settings["enableArcGroupMerging"] or len(candidates) < 2:
        return {"candidates": candidates, "debug": []}
    out: list[dict[str, Any]] = []
    debug: list[dict[str, Any]] = []
    i = 0
    group_serial = 1
    while i < len(candidates):
        best = None
        max_size = min(settings["maxMergeGroupSize"], len(candidates) - i)
        for size in range(2, max_size + 1):
            group = candidates[i:i + size]
            evaluation = evaluate_arc_group_merge(contour, group, settings, f"GM{loop_number}-{group_serial}")
            debug.append(evaluation["debug"])
            group_serial += 1
            if not evaluation["debug"]["merged"]:
                continue
            if not best or evaluation["debug"]["mergeScore"] > best["debug"]["mergeScore"]:
                best = evaluation
        if best:
            out.append(best["candidate"])
            i += best["groupSize"]
        else:
            out.append(candidates[i])
            i += 1
    return {"candidates": out, "debug": debug}


def evaluate_arc_group_merge(contour: list[Point], group: list[dict[str, Any]], settings: dict[str, Any], group_id: str) -> dict[str, Any]:
    member_arc_ids = [arc_id for candidate in group for arc_id in candidate["sourceCandidateIds"]]
    contour_range = contour_range_for_candidates(group, len(contour))
    not_contiguous = not are_candidate_indices_contiguous(group, len(contour))
    tangent_angle_deltas = tangent_deltas_for_group(group)
    mean_tangent_delta = sum(tangent_angle_deltas) / max(1, len(tangent_angle_deltas))
    max_tangent_delta = max(tangent_angle_deltas or [0])
    indices: list[int] = []
    for candidate in group:
        indices = merge_contour_indices(indices, candidate["indices"], len(contour))
    points = points_for_contour_segment(contour, indices)
    refit = (fit_circle_to_points(points) or fallback_circle_for_points(points)) if len(points) >= 3 else None
    original_error = weighted_original_error(group)
    refit_error = refit["error"] if refit else math.inf
    error_increase_ratio = refit_error / max(0.15, original_error)
    simplicity_gain = (len(group) - 1) / max(1, len(group))
    tangent_continuity_score = max(0, 1 - mean_tangent_delta / max(1, settings["tangentMergeThreshold"]))
    absolute_error_penalty = max(0, refit_error / max(0.1, settings["refitErrorThreshold"]) - 1)
    feature_loss_penalty = feature_loss_penalty_for_group(group, refit_error, max_tangent_delta, settings)
    merge_score = (
        settings["simplicityWeight"] * simplicity_gain
        + settings["tangentWeight"] * tangent_continuity_score
        - settings["errorWeight"] * max(0, error_increase_ratio - 1)
        - settings["errorWeight"] * absolute_error_penalty
        - feature_loss_penalty
    )
    rejection_reason = None
    if not_contiguous:
        rejection_reason = "not_contiguous"
    elif max_tangent_delta > settings["tangentMergeThreshold"] * 1.9:
        rejection_reason = "tangent_break_too_large"
    elif refit_error > settings["refitErrorThreshold"]:
        rejection_reason = "high_refit_error"
    elif error_increase_ratio > settings["errorIncreaseThreshold"]:
        rejection_reason = "high_refit_error"
    elif feature_loss_penalty > 0:
        rejection_reason = "feature_loss"
    elif merge_score < 0.28:
        rejection_reason = "merge_score_too_low"
    merged = bool(refit and not rejection_reason)
    debug = {
        "groupId": group_id,
        "memberArcIds": member_arc_ids,
        "contourRange": contour_range,
        "originalError": original_error,
        "refitError": refit_error,
        "errorIncreaseRatio": error_increase_ratio,
        "meanTangentDelta": mean_tangent_delta,
        "maxTangentDelta": max_tangent_delta,
        "simplicityGain": simplicity_gain,
        "mergeScore": merge_score,
        "merged": merged,
        **({"rejectionReason": rejection_reason} if rejection_reason else {}),
    }
    candidate = {
        "indices": indices,
        "points": points,
        "fit": refit,
        "memberCount": sum(item["memberCount"] for item in group),
        "sourceCandidateIds": member_arc_ids,
        "mergeInfo": {
            "originalError": original_error,
            "refitError": refit_error,
            "tangentDeltaStats": {"mean": mean_tangent_delta, "max": max_tangent_delta},
            "simplicityGain": simplicity_gain,
            "mergeReason": "smooth_contiguous_arc_group_refit",
        },
    } if merged and refit else group[0]
    return {"candidate": candidate, "debug": debug, "groupSize": len(group)}


def are_candidate_indices_contiguous(group: list[dict[str, Any]], contour_length: int) -> bool:
    for i in range(len(group) - 1):
        a = group[i]["indices"][-1]
        b = group[i + 1]["indices"][0]
        forward_gap = (b - a + contour_length) % contour_length
        if forward_gap > 3 and forward_gap < contour_length - 3:
            return False
    return True


def contour_range_for_candidates(group: list[dict[str, Any]], contour_length: int) -> dict[str, int]:
    start_index = group[0]["indices"][0] if group[0]["indices"] else 0
    end_index = group[-1]["indices"][-1] if group[-1]["indices"] else start_index
    indices: list[int] = []
    for candidate in group:
        indices = merge_contour_indices(indices, candidate["indices"], contour_length)
    return {"startIndex": start_index, "endIndex": end_index, "count": len(indices)}


def tangent_deltas_for_group(group: list[dict[str, Any]]) -> list[float]:
    out: list[float] = []
    for i in range(len(group) - 1):
        a = group[i]
        b = group[i + 1]
        a_end = a["points"][-1]
        b_start = b["points"][0]
        a_angle = tangent_angle_at_point(a_end, a["fit"], arc_direction_for_candidate(a))
        b_angle = tangent_angle_at_point(b_start, b["fit"], arc_direction_for_candidate(b))
        out.append(smallest_angle_difference(a_angle, b_angle))
    return out


def arc_direction_for_candidate(candidate: dict[str, Any]) -> str:
    start = point_angle_from_center(candidate["points"][0], candidate["fit"]["cx"], candidate["fit"]["cy"])
    end = point_angle_from_center(candidate["points"][-1], candidate["fit"]["cx"], candidate["fit"]["cy"])
    mid = point_angle_from_center(candidate["points"][len(candidate["points"]) // 2], candidate["fit"]["cx"], candidate["fit"]["cy"])
    return "ccw" if angle_in_arc(mid, start, end) else "cw"


def tangent_angle_at_point(point: Point, fit: dict[str, float], direction: str) -> float:
    theta = math.atan2(point["y"] - fit["cy"], point["x"] - fit["cx"])
    sign = 1 if direction == "ccw" else -1
    tx = -fit["r"] * math.sin(theta) * sign
    ty = fit["r"] * math.cos(theta) * sign
    return normalize_angle(math.degrees(math.atan2(ty, tx)))


def smallest_angle_difference(a: float, b: float) -> float:
    delta = abs(normalize_angle(a - b))
    return min(delta, 360 - delta)


def weighted_original_error(group: list[dict[str, Any]]) -> float:
    total = sum(len(candidate["points"]) for candidate in group)
    return sum(candidate["fit"]["error"] * len(candidate["points"]) for candidate in group) / max(1, total)


def feature_loss_penalty_for_group(group: list[dict[str, Any]], refit_error: float, max_tangent_delta: float, settings: dict[str, Any]) -> float:
    very_short_feature = any(len(candidate["points"]) <= 5 and candidate["fit"]["r"] <= settings["minFittedRadius"] * 3 for candidate in group)
    sharp_turn = max_tangent_delta > settings["tangentMergeThreshold"] * 1.45
    noisy_refit = refit_error > settings["refitErrorThreshold"] * 0.86
    return (0.22 if very_short_feature else 0) + (0.32 if sharp_turn else 0) + (0.18 if noisy_refit else 0)


def are_redundant_contour_fits(a: dict[str, float], b: dict[str, float], settings: dict[str, Any]) -> bool:
    min_radius = max(1, min(a["r"], b["r"]))
    center_distance = math.hypot(a["cx"] - b["cx"], a["cy"] - b["cy"])
    normalized_radius_difference = abs(a["r"] - b["r"]) / min_radius
    return center_distance <= max(settings["duplicateCenterTolerance"], min_radius * 0.16) and normalized_radius_difference <= settings["duplicateRadiusTolerance"]


def merge_contour_indices(a: list[int], b: list[int], contour_length: int) -> list[int]:
    out: list[int] = []
    for index in a + b:
        normalized = index % contour_length
        if not out or out[-1] != normalized:
            out.append(normalized)
    return out


def chunk_contour_indices(length: int, count: int) -> list[list[int]]:
    segments: list[list[int]] = []
    for chunk_index in range(count):
        start = round((chunk_index / count) * length)
        end = round(((chunk_index + 1) / count) * length)
        segment = [i % length for i in range(start, end)]
        if len(segment) >= 4:
            segments.append(segment)
    return segments


def points_for_contour_segment(contour: list[Point], indices: list[int]) -> list[Point]:
    points = [contour[index] for index in indices if 0 <= index < len(contour)]
    if indices:
        points.append(contour[(indices[-1] + 1) % len(contour)])
    return points


def fit_circle_to_points(points: list[Point]) -> dict[str, float] | None:
    sum_x = sum_y = sum_xx = sum_yy = sum_xy = sum_xxx = sum_yyy = sum_xyy = sum_xxy = 0.0
    for point in points:
        x = point["x"]
        y = point["y"]
        xx = x * x
        yy = y * y
        sum_x += x
        sum_y += y
        sum_xx += xx
        sum_yy += yy
        sum_xy += x * y
        sum_xxx += xx * x
        sum_yyy += yy * y
        sum_xyy += x * yy
        sum_xxy += xx * y
    n = len(points)
    solution = solve_3x3(
        [[sum_xx, sum_xy, sum_x], [sum_xy, sum_yy, sum_y], [sum_x, sum_y, n]],
        [-(sum_xxx + sum_xyy), -(sum_xxy + sum_yyy), -(sum_xx + sum_yy)],
    )
    if not solution:
        return None
    a, b, c = solution
    cx = -a / 2
    cy = -b / 2
    r2 = cx * cx + cy * cy - c
    if not math.isfinite(r2) or r2 <= 1:
        return None
    r = math.sqrt(r2)
    error = sum(abs(math.hypot(point["x"] - cx, point["y"] - cy) - r) for point in points) / len(points)
    if not math.isfinite(error):
        return None
    return {"cx": cx, "cy": cy, "r": r, "error": error}


def fallback_circle_for_points(points: list[Point]) -> dict[str, float]:
    first = points[0]
    middle = points[len(points) // 2]
    last = points[-1]
    fit = circle_through_three_points(first, middle, last)
    if fit:
        error = sum(abs(math.hypot(point["x"] - fit["cx"], point["y"] - fit["cy"]) - fit["r"]) for point in points) / len(points)
        return {**fit, "error": error}
    cx = sum(point["x"] for point in points) / len(points)
    cy = sum(point["y"] for point in points) / len(points)
    r = max(4, sum(math.hypot(point["x"] - cx, point["y"] - cy) for point in points) / len(points))
    return {"cx": cx, "cy": cy, "r": r, "error": r}


def solve_3x3(matrix: list[list[float]], vector: list[float]) -> list[float] | None:
    a = [row[:] + [vector[index]] for index, row in enumerate(matrix)]
    for col in range(3):
        pivot = col
        for row in range(col + 1, 3):
            if abs(a[row][col]) > abs(a[pivot][col]):
                pivot = row
        if abs(a[pivot][col]) < 1e-9:
            return None
        a[col], a[pivot] = a[pivot], a[col]
        divisor = a[col][col]
        for i in range(col, 4):
            a[col][i] /= divisor
        for row in range(3):
            if row == col:
                continue
            factor = a[row][col]
            for i in range(col, 4):
                a[row][i] -= factor * a[col][i]
    return [a[0][3], a[1][3], a[2][3]]


def circle_through_three_points(a: Point, b: Point, c: Point) -> dict[str, float] | None:
    d = 2 * (a["x"] * (b["y"] - c["y"]) + b["x"] * (c["y"] - a["y"]) + c["x"] * (a["y"] - b["y"]))
    if abs(d) < 0.001:
        return None
    a2 = a["x"] * a["x"] + a["y"] * a["y"]
    b2 = b["x"] * b["x"] + b["y"] * b["y"]
    c2 = c["x"] * c["x"] + c["y"] * c["y"]
    cx = (a2 * (b["y"] - c["y"]) + b2 * (c["y"] - a["y"]) + c2 * (a["y"] - b["y"])) / d
    cy = (a2 * (c["x"] - b["x"]) + b2 * (a["x"] - c["x"]) + c2 * (b["x"] - a["x"])) / d
    r = math.hypot(a["x"] - cx, a["y"] - cy)
    if not math.isfinite(r) or r < 4 or r > 2000:
        return None
    return {"cx": cx, "cy": cy, "r": r}


def sample_arc_loop_segment(piece: dict[str, Any], sample_spacing: float = 8) -> list[Point]:
    span = angle_span(piece["startAngle"], piece["endAngle"]) if piece["direction"] == "ccw" else angle_span(piece["endAngle"], piece["startAngle"])
    steps = max(4, math.ceil((span / 360) * math.pi * 2 * piece["r"] / max(2, sample_spacing)))
    points: list[Point] = []
    for i in range(steps + 1):
        delta = (span * i) / steps
        angle = normalize_angle(piece["startAngle"] + delta) if piece["direction"] == "ccw" else normalize_angle(piece["startAngle"] - delta)
        radians = math.radians(angle)
        points.append({"x": piece["cx"] + math.cos(radians) * piece["r"], "y": piece["cy"] + math.sin(radians) * piece["r"]})
    points[0] = piece["startPoint"]
    points[-1] = piece["endPoint"]
    return points


def sample_face_points(polygon: list[Point], centroid: Point) -> list[Point]:
    if not polygon:
        return [centroid]
    step = max(1, math.floor(len(polygon) / 12))
    return [centroid] + [point for index, point in enumerate(polygon) if index % step == 0]


def assign_face_nesting(faces: list[dict[str, Any]]) -> None:
    for face in faces:
        containers = [other for other in faces if other["id"] != face["id"] and point_in_polygon(face["centroid"], other["polygon"])]
        face["nestingDepth"] = len(containers)
        containers.sort(key=lambda other: other["area"])
        if containers:
            face["parentFaceId"] = containers[0]["id"]


def polyline_length(points: list[Point]) -> float:
    return sum(math.hypot(points[i]["x"] - points[i - 1]["x"], points[i]["y"] - points[i - 1]["y"]) for i in range(1, len(points)))


def point_in_polygon(point: Point, polygon: list[Point]) -> bool:
    inside = False
    j = len(polygon) - 1
    for i, a in enumerate(polygon):
        b = polygon[j]
        intersects = (a["y"] > point["y"]) != (b["y"] > point["y"]) and point["x"] < ((b["x"] - a["x"]) * (point["y"] - a["y"])) / max(0.0001, b["y"] - a["y"]) + a["x"]
        if intersects:
            inside = not inside
        j = i
    return inside


def sample_face_inside_mask(analysis: dict[str, Any], polygon: list[Point], centroid: Point) -> float:
    step = max(1, math.floor(len(polygon) / 12)) if polygon else 1
    samples = [centroid] + [{"x": centroid["x"] * 0.65 + point["x"] * 0.35, "y": centroid["y"] * 0.65 + point["y"] * 0.35} for index, point in enumerate(polygon) if index % step == 0]
    inside = 0
    for sample in samples:
        x = round(sample["x"])
        y = round(sample["y"])
        if 0 <= x < analysis["width"] and 0 <= y < analysis["height"] and analysis["mask"][y * analysis["width"] + x]:
            inside += 1
    return inside / max(1, len(samples))


def polygon_area(points: list[Point]) -> float:
    area = 0.0
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        area += a["x"] * b["y"] - b["x"] * a["y"]
    return area / 2


def polygon_centroid(points: list[Point]) -> Point:
    x = y = area_factor = 0.0
    for i, a in enumerate(points):
        b = points[(i + 1) % len(points)]
        cross = a["x"] * b["y"] - b["x"] * a["y"]
        x += (a["x"] + b["x"]) * cross
        y += (a["y"] + b["y"]) * cross
        area_factor += cross
    if abs(area_factor) < 0.001:
        return {"x": sum(point["x"] for point in points) / len(points), "y": sum(point["y"] for point in points) / len(points)}
    return {"x": x / (3 * area_factor), "y": y / (3 * area_factor)}


def suppress_near_duplicate_circle_visibility(circles: list[dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    sorted_circles = sorted(circles, key=circle_keep_priority, reverse=True)
    kept: list[dict[str, Any]] = []
    hidden: set[str] = set()
    for circle in sorted_circles:
        duplicate = next((other for other in kept if are_near_duplicate_circles(circle, other, settings)), None)
        if duplicate:
            hidden.add(circle["id"])
            continue
        kept.append(circle)
    return limit_visible_boundary_circles([{**circle, "visible": False} if circle["id"] in hidden else circle for circle in circles], settings)


def limit_visible_boundary_circles(circles: list[dict[str, Any]], settings: dict[str, Any]) -> list[dict[str, Any]]:
    visible_boundary = sorted([circle for circle in circles if circle.get("visible") and circle.get("role") == "boundary"], key=circle_keep_priority, reverse=True)
    keep = {circle["id"] for circle in visible_boundary[:max(0, int(settings["visibleParentCircleLimit"]))]}
    return [circle if circle.get("role") != "boundary" or not circle.get("visible") or circle["id"] in keep else {**circle, "visible": False} for circle in circles]


def circle_keep_priority(circle: dict[str, Any]) -> float:
    final_weight = 10000 if circle.get("usedInFinal") else 0
    role_weight = 2000 if circle.get("role") == "boundary" else 400 if circle.get("role") == "helper" else 800
    support_weight = circle.get("contourSupport", 0) * 1000 + circle.get("arcLength", 0) * 0.8
    error_penalty = circle.get("fitError", 0) * 20
    return final_weight + role_weight + support_weight - error_penalty


def are_near_duplicate_circles(a: dict[str, Any], b: dict[str, Any], settings: dict[str, Any]) -> bool:
    min_radius = max(1, min(a["radius"], b["radius"]))
    center_distance = math.hypot(a["centerX"] - b["centerX"], a["centerY"] - b["centerY"])
    radius_delta = abs(a["radius"] - b["radius"])
    helper_pair = (not a.get("usedInFinal")) or (not b.get("usedInFinal"))
    center_tolerance = max(settings["duplicateCenterTolerance"] * (1.25 if helper_pair else 1), min_radius * (0.16 if helper_pair else 0.14))
    radius_tolerance = max(16 if helper_pair else 8, min_radius * settings["duplicateRadiusTolerance"] * (1.25 if helper_pair else 1))
    very_close_center = center_distance <= max(10 if helper_pair else 8, min_radius * (0.08 if helper_pair else 0.06))
    almost_same_radius = radius_delta <= max(8 if helper_pair else 4, min_radius * settings["duplicateRadiusTolerance"] * 0.7)
    overlapping_similar_circle = center_distance <= min_radius * 0.5 and radius_delta <= min_radius * 0.28
    return (center_distance <= center_tolerance and radius_delta <= radius_tolerance) or (very_close_center and almost_same_radius) or overlapping_similar_circle


def build_svg(
    construction: dict[str, Any],
    helper_opacity: float,
    show_helpers: bool = True,
    image_overlay_url: str = "",
    image_overlay_opacity: float = 0,
    mask_overlay_url: str = "",
    mask_overlay_opacity: float = 0,
    role_visibility: dict[str, bool] | None = None,
) -> str:
    role_visibility = role_visibility or {}
    silhouette_markup = build_vector_silhouette(construction)
    image_overlay_markup = (
        f'<image href="{escape_attribute(image_overlay_url)}" x="0" y="0" width="{construction["width"]}" height="{construction["height"]}" preserveAspectRatio="none" opacity="{image_overlay_opacity:.2f}" />'
        if image_overlay_url and image_overlay_opacity > 0 else ""
    )
    mask_overlay_markup = (
        f'<image href="{escape_attribute(mask_overlay_url)}" x="0" y="0" width="{construction["width"]}" height="{construction["height"]}" preserveAspectRatio="none" opacity="{mask_overlay_opacity:.2f}" />'
        if mask_overlay_url and mask_overlay_opacity > 0 else ""
    )
    helper_markup = ""
    arc_markup = ""
    if show_helpers:
        helper_lines = []
        for circle in build_displayed_helper_circles(construction, role_visibility):
            stroke = "#a34835" if circle["role"] == "subtract" else "#59616d" if circle["role"] == "add" else "#7a8594" if circle["role"] == "boundary" else "#9ba0a8"
            dash = ' stroke-dasharray="6 4"' if circle["role"] == "subtract" else ' stroke-dasharray="4 5"' if circle["role"] == "helper" else ""
            helper_lines.append(f'<circle cx="{circle["cx"]:.2f}" cy="{circle["cy"]:.2f}" r="{circle["r"]:.2f}" fill="none" stroke="{stroke}" stroke-width="1.4" vector-effect="non-scaling-stroke" opacity="{helper_opacity:.2f}"{dash} />')
        helper_markup = "\n".join(helper_lines)
        arc_lines = []
        for face in construction["faces"]:
            if not face["selected"]:
                continue
            for piece in face["arcPieces"]:
                circle = next((item for item in construction["circles"] if item["id"] == piece["circleId"]), None)
                if circle and not role_visibility.get(circle["role"], True):
                    continue
                arc_lines.append(arc_piece_to_stroke_path(piece, min(0.92, helper_opacity + 0.25)))
        arc_markup = "\n".join(arc_lines)
    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="{construction["width"]}" height="{construction["height"]}" viewBox="0 0 {construction["width"]} {construction["height"]}">
  <rect width="100%" height="100%" fill="#f7f4ed"/>
  {silhouette_markup}
  {image_overlay_markup}
  {mask_overlay_markup}
  {helper_markup}
  {arc_markup}
</svg>"""


def build_vector_silhouette(construction: dict[str, Any]) -> str:
    selected_loops = [face for face in construction["faces"] if face["selected"] and face["arcPieces"]]
    if not selected_loops:
        return ""
    paths = "\n".join(filter(None, [arc_loop_to_path(face) for face in selected_loops]))
    return f'<path data-fill-mode="arc-loops" data-shape-expression="selected circular arcs -> closed arc loops -> fill inside loops" d="{paths}" fill="#111111" fill-rule="evenodd"/>'


def arc_loop_to_path(face: dict[str, Any]) -> str:
    if not face["arcPieces"]:
        return ""
    first = face["arcPieces"][0]
    commands = [f'M {first["startPoint"]["x"]:.2f} {first["startPoint"]["y"]:.2f}']
    for piece in face["arcPieces"]:
        span = angle_span(piece["startAngle"], piece["endAngle"]) if piece["direction"] == "ccw" else angle_span(piece["endAngle"], piece["startAngle"])
        large_arc_flag = 1 if span > 180 else 0
        sweep_flag = 1 if piece["direction"] == "ccw" else 0
        commands.append(f'A {piece["r"]:.2f} {piece["r"]:.2f} 0 {large_arc_flag} {sweep_flag} {piece["endPoint"]["x"]:.2f} {piece["endPoint"]["y"]:.2f}')
    commands.append("Z")
    return " ".join(commands)


def arc_piece_to_stroke_path(piece: dict[str, Any], opacity: float) -> str:
    span = angle_span(piece["startAngle"], piece["endAngle"]) if piece["direction"] == "ccw" else angle_span(piece["endAngle"], piece["startAngle"])
    large_arc_flag = 1 if span > 180 else 0
    sweep_flag = 1 if piece["direction"] == "ccw" else 0
    return f'<path d="M {piece["startPoint"]["x"]:.2f} {piece["startPoint"]["y"]:.2f} A {piece["r"]:.2f} {piece["r"]:.2f} 0 {large_arc_flag} {sweep_flag} {piece["endPoint"]["x"]:.2f} {piece["endPoint"]["y"]:.2f}" fill="none" stroke="#252a31" stroke-width="3.1" vector-effect="non-scaling-stroke" opacity="{opacity:.2f}" />'


def build_displayed_helper_circles(construction: dict[str, Any], role_visibility: dict[str, bool]) -> list[dict[str, Any]]:
    visible_boundary_limit = len([circle for circle in construction["circles"] if circle.get("visible") and circle.get("role") == "boundary"])
    arc_derived = []
    if role_visibility.get("boundary", True):
        arc_derived = unique_helper_circles([
            circle for circle in [
                svg_circle_from_arc_piece(piece)
                for face in construction["faces"] if face["selected"]
                for piece in face["arcPieces"]
            ] if circle
        ])[:max(0, visible_boundary_limit)]
    non_boundary = [
        {"cx": circle["centerX"], "cy": circle["centerY"], "r": circle["radius"], "role": circle["role"]}
        for circle in construction["circles"]
        if circle.get("visible") and circle.get("role") != "boundary" and role_visibility.get(circle["role"], True)
    ]
    return arc_derived + non_boundary


def svg_circle_from_arc_piece(piece: dict[str, Any]) -> dict[str, Any] | None:
    span = angle_span(piece["startAngle"], piece["endAngle"]) if piece["direction"] == "ccw" else angle_span(piece["endAngle"], piece["startAngle"])
    large_arc_flag = 1 if span > 180 else 0
    sweep_flag = 1 if piece["direction"] == "ccw" else 0
    circle = svg_circle_from_arc(piece["startPoint"]["x"], piece["startPoint"]["y"], piece["endPoint"]["x"], piece["endPoint"]["y"], piece["r"], large_arc_flag, sweep_flag)
    return {**circle, "role": "boundary"} if circle else None


def svg_circle_from_arc(x1: float, y1: float, x2: float, y2: float, radius: float, large_arc_flag: int, sweep_flag: int) -> dict[str, float] | None:
    dx = (x1 - x2) / 2
    dy = (y1 - y2) / 2
    chord_half_squared = dx * dx + dy * dy
    if chord_half_squared < 0.000001:
        return None
    r = max(0.001, radius)
    lam = chord_half_squared / (r * r)
    if lam > 1:
        r *= math.sqrt(lam)
    numerator = max(0, r * r - chord_half_squared)
    coefficient = (-1 if large_arc_flag == sweep_flag else 1) * math.sqrt(numerator / chord_half_squared)
    cx = (x1 + x2) / 2 + coefficient * dy
    cy = (y1 + y2) / 2 - coefficient * dx
    if not math.isfinite(cx) or not math.isfinite(cy) or not math.isfinite(r):
        return None
    return {"cx": cx, "cy": cy, "r": r}


def unique_helper_circles(circles: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for circle in circles:
        duplicate = any(
            math.hypot(circle["cx"] - other["cx"], circle["cy"] - other["cy"]) <= max(8, max(1, min(circle["r"], other["r"])) * 0.08)
            and abs(circle["r"] - other["r"]) <= max(4, max(1, min(circle["r"], other["r"])) * 0.06)
            for other in out
        )
        if not duplicate:
            out.append(circle)
    return out


def build_formula_table(construction: dict[str, Any], labels: dict[str, str] | None = None) -> list[dict[str, Any]]:
    labels = labels or {}
    rows = []
    for index, piece in enumerate(get_selected_arc_pieces(construction)):
        label = labels.get(piece["arcId"], "").strip() or f"円弧{index + 1}"
        curvature = 1 / max(0.000001, piece["r"])
        circle_equation = f'(x - {piece["cx"]:.2f})^2 + (y - {piece["cy"]:.2f})^2 = {piece["r"]:.2f}^2'
        parametric_equation = f'x = {piece["cx"]:.2f} + {piece["r"]:.2f} cos(theta), y = {piece["cy"]:.2f} + {piece["r"]:.2f} sin(theta)'
        interval = f'{piece["startAngle"]:.2f} deg <= theta <= {piece["endAngle"]:.2f} deg'
        rows.append({
            "arcId": piece["arcId"],
            "circleId": piece["circleId"],
            "label": label,
            "centerX": piece["cx"],
            "centerY": piece["cy"],
            "radius": piece["r"],
            "startAngle": piece["startAngle"],
            "endAngle": piece["endAngle"],
            "direction": piece["direction"],
            "arcLength": arc_length(piece),
            "fitError": piece["fitError"],
            "contourSupport": piece["contourSupport"],
            "curvature": curvature,
            "circleEquation": circle_equation,
            "parametricEquation": parametric_equation,
            "interval": interval,
            "reportText": f"Circle equation: {circle_equation}\nParametric equation: {parametric_equation}\nInterval: {interval}",
        })
    return rows


def build_derivative_info(construction: dict[str, Any], labels: dict[str, str] | None = None) -> list[dict[str, Any]]:
    labels = labels or {}
    out = []
    for index, piece in enumerate(get_selected_arc_pieces(construction)):
        label = labels.get(piece["arcId"], "").strip() or f"円弧{index + 1}"
        start = tangent_sample(piece, piece["startAngle"])
        mid = tangent_sample(piece, midpoint_angle(piece))
        end = tangent_sample(piece, piece["endAngle"])
        out.append({
            "arcId": piece["arcId"],
            "circleId": piece["circleId"],
            "label": label,
            "curvature": 1 / max(0.000001, piece["r"]),
            "startTangentVector": start["tangentVector"],
            "midTangentVector": mid["tangentVector"],
            "endTangentVector": end["tangentVector"],
            "startTangentAngle": start["tangentAngle"],
            "midTangentAngle": mid["tangentAngle"],
            "endTangentAngle": end["tangentAngle"],
            "startSlope": start["slope"],
            "midSlope": mid["slope"],
            "endSlope": end["slope"],
            "verticalTangent": start["verticalTangent"] or mid["verticalTangent"] or end["verticalTangent"],
            "start": start,
            "mid": mid,
            "end": end,
            "derivativeFormula": "dx/dtheta = -r sin(theta), dy/dtheta = r cos(theta), tangent vector = (-r sin(theta), r cos(theta))",
            "implicitDerivativeFormula": "dy/dx = -(x-a)/(y-b)",
        })
    return out


def build_connection_info(construction: dict[str, Any], labels: dict[str, str] | None = None) -> list[dict[str, Any]]:
    labels = labels or {}
    pieces = get_selected_arc_pieces(construction)
    if len(pieces) < 2:
        return []
    out = []
    for index, piece in enumerate(pieces):
        next_piece = pieces[(index + 1) % len(pieces)]
        from_end = tangent_sample(piece, piece["endAngle"])
        to_start = tangent_sample(next_piece, next_piece["startAngle"])
        position_gap = math.hypot(piece["endPoint"]["x"] - next_piece["startPoint"]["x"], piece["endPoint"]["y"] - next_piece["startPoint"]["y"])
        tangent_angle_delta = smallest_angle_difference(from_end["tangentAngle"], to_start["tangentAngle"])
        tangent_continuity_score = max(0, 1 - tangent_angle_delta / 90) * max(0, 1 - position_gap / 24)
        out.append({
            "fromArcId": piece["arcId"],
            "toArcId": next_piece["arcId"],
            "positionGap": position_gap,
            "fromEndTangentAngle": from_end["tangentAngle"],
            "toStartTangentAngle": to_start["tangentAngle"],
            "tangentAngleDelta": tangent_angle_delta,
            "tangentContinuityScore": tangent_continuity_score,
            "connectionType": classify_connection(position_gap, tangent_angle_delta, labels.get(piece["arcId"], ""), labels.get(next_piece["arcId"], "")),
        })
    return out


def build_report_data(input_data: dict[str, Any]) -> dict[str, Any]:
    formula_table = build_formula_table(input_data["construction"], input_data.get("labels", {}))
    construction = input_data["construction"]
    return {
        "title": input_data["title"],
        "concept": input_data["concept"],
        "sourceImageInfo": input_data["sourceImageInfo"],
        "settings": input_data["settings"],
        "arcs": formula_table,
        "circles": construction["circles"],
        "formulaTable": formula_table,
        "derivativeInfo": build_derivative_info(construction, input_data.get("labels", {})),
        "connectionInfo": build_connection_info(construction, input_data.get("labels", {})),
        "helperCircles": [circle for circle in construction["circles"] if not circle.get("usedInFinal") or circle.get("role") == "helper"],
        "arcGroupMergeDebug": construction["arcGroupMergeDebug"],
        "mergedArcInfo": construction["mergedArcInfo"],
        "processSummary": [
            "入力画像をキャンバスに読み込み、輝度をもとに二値化した。",
            "二値化マスクから境界画素を見つけ、輪郭を抽出した。",
            "輪郭点列を平滑化し、弧長に沿って再サンプリングした。",
            "輪郭の接線方向の変化が大きい点を使ってセグメントに分割した。",
            "各セグメントの点群を円弧に最小二乗フィットした。",
            "中心と半径が近い円を統合し、冗長な補助円を抑制した。",
            "輪郭順に連続する円弧群について、微分から得た接線方向と再フィット誤差を調べ、過剰分割された滑らかな区間を代表円弧に統合した。",
            "採用した円弧列をSVG pathとして閉じ、内部を塗って完成形にした。",
            "補助円を表示し、作品を構成する親円が分かる設計図として確認した。",
        ],
        "improvementLogTemplate": [
            "初期案: 塗り円を足し引きする方法で形を近似したが、輪郭の説明が弱かった。",
            "改善1: 塗り優先から輪郭優先に切り替え、下絵の境界に沿って円弧を選ぶようにした。",
            "改善2: 円の合成結果ではなく、円弧列そのものを閉じたSVG pathに変換する方式にした。",
            "改善3: 半径や中心の近さだけでなく、接線方向の連続性と再フィット誤差で過剰分割された円弧群を統合した。",
            "改善4: 数式一覧、微分情報、接続点の接線角度差を出力し、数学的な説明に使えるようにした。",
            "最終確認: 完成作品、補助円つき設計図、下絵/マスク/輪郭の工程画像を分けて保存した。",
        ],
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def get_selected_arc_pieces(construction: dict[str, Any]) -> list[dict[str, Any]]:
    selected = [piece for face in construction["faces"] if face["selected"] for piece in face["arcPieces"]]
    if selected:
        source = selected
    else:
        source = []
        for piece in construction["splitArcPieces"]:
            if not piece["selectedAsBoundary"]:
                continue
            circle = next((item for item in construction["circles"] if item["id"] == piece["parentCircleId"]), None)
            source.append({
                "id": piece["id"],
                "circleId": piece["parentCircleId"],
                "cx": circle["centerX"] if circle else 0,
                "cy": circle["centerY"] if circle else 0,
                "r": circle["radius"] if circle else 0,
                "startAngle": piece["startAngle"],
                "endAngle": piece["endAngle"],
                "startPoint": piece["startPoint"],
                "endPoint": piece["endPoint"],
                "direction": infer_direction(piece["startAngle"], piece["endAngle"]),
                "contourSupport": circle["contourSupport"] if circle else 0,
                "fitError": circle["fitError"] if circle else 0,
            })
    out = []
    for piece in source:
        split_piece = next((item for item in construction["splitArcPieces"] if item["id"] == piece["id"] or item["parentCircleId"] == piece["circleId"]), None)
        out.append({**piece, "arcId": split_piece["parentArcId"] if split_piece else piece["id"]})
    return out


def tangent_sample(piece: dict[str, Any], angle: float) -> dict[str, Any]:
    theta = math.radians(angle)
    direction_sign = 1 if piece["direction"] == "ccw" else -1
    base_vector = {"x": -piece["r"] * math.sin(theta), "y": piece["r"] * math.cos(theta)}
    tangent_vector = {"x": base_vector["x"] * direction_sign, "y": base_vector["y"] * direction_sign}
    point = {"x": piece["cx"] + piece["r"] * math.cos(theta), "y": piece["cy"] + piece["r"] * math.sin(theta)}
    vertical_tangent = abs(point["y"] - piece["cy"]) < 0.000001 or abs(tangent_vector["x"]) < 0.000001
    slope = None if vertical_tangent else -(point["x"] - piece["cx"]) / (point["y"] - piece["cy"])
    return {
        "point": point,
        "angle": normalize_angle(angle),
        "tangentVector": tangent_vector,
        "tangentAngle": normalize_angle(math.degrees(math.atan2(tangent_vector["y"], tangent_vector["x"]))),
        "slope": slope,
        "verticalTangent": vertical_tangent,
    }


def midpoint_angle(piece: dict[str, Any]) -> float:
    span = angle_span(piece["startAngle"], piece["endAngle"]) if piece["direction"] == "ccw" else angle_span(piece["endAngle"], piece["startAngle"])
    return normalize_angle(piece["startAngle"] + span / 2) if piece["direction"] == "ccw" else normalize_angle(piece["startAngle"] - span / 2)


def arc_length(piece: dict[str, Any]) -> float:
    span = angle_span(piece["startAngle"], piece["endAngle"]) if piece["direction"] == "ccw" else angle_span(piece["endAngle"], piece["startAngle"])
    return (span / 360) * math.pi * 2 * piece["r"]


def classify_connection(position_gap: float, angle_delta: float, from_label: str = "", to_label: str = "") -> str:
    intentional_corner = any(term in f"{from_label} {to_label}" for term in ["角", "corner", "くびれ", "先端"])
    if position_gap > 14:
        return "gap"
    if angle_delta <= 18:
        return "smooth"
    if intentional_corner or angle_delta <= 55:
        return "corner"
    return "bad_tangent"


def infer_direction(start_angle: float, end_angle: float) -> str:
    return "ccw" if angle_span(start_angle, end_angle) <= 180 else "cw"


def escape_attribute(value: str) -> str:
    return value.replace("&", "&amp;").replace('"', "&quot;").replace("<", "&lt;").replace(">", "&gt;")


def generate_payload(request: dict[str, Any]) -> dict[str, Any]:
    settings = request.get("settings", {})
    analysis = image_data_to_analysis(
        {"width": request["width"], "height": request["height"], "data": request["data"]},
        settings.get("threshold", 118),
        settings.get("blur", 2),
        settings.get("edgeStrength", 2),
    )
    construction = build_construction(analysis, [], settings)
    labels = request.get("labels", {})
    report_data = build_report_data({
        "construction": construction,
        "labels": labels,
        "settings": settings,
        "title": request.get("title", "Arc Anatomy: 円弧だけで描くシルエット"),
        "concept": request.get("concept", "下絵の輪郭を円弧の集合として近似し、補助円と微分情報で構造を説明できる関数グラフアート。"),
        "sourceImageInfo": {
            "name": request.get("imageName", "sample-motif"),
            "width": construction["width"],
            "height": construction["height"],
            "source": request.get("source", "browser-image-data"),
        },
    })
    return {
        "construction": construction,
        "analysis": {
            "width": analysis["width"],
            "height": analysis["height"],
            "mask": analysis["mask"],
            "edge": analysis["edge"],
            "contourPoints": analysis["contourPoints"],
            "contourSegments": analysis["contourSegments"],
        },
        "formulaTable": report_data["formulaTable"],
        "derivativeInfo": report_data["derivativeInfo"],
        "connectionInfo": report_data["connectionInfo"],
        "reportData": report_data,
        "svg": build_svg(construction, settings.get("helperOpacity", 0.48), settings.get("showHelpers", True), "", 0, "", 0, {
            "add": settings.get("showAddCircles", True),
            "subtract": settings.get("showSubtractCircles", True),
            "boundary": settings.get("showBoundaryCircles", True),
            "helper": settings.get("showHelperCircles", True),
            "candidate": settings.get("showCandidates", False),
        }),
    }


def dumps(data: Any) -> str:
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"))
