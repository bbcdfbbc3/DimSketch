"""원본 사진과 ZIP 자료를 실제 파일 형식으로 만드는 검증 도우미."""

from __future__ import annotations

from io import BytesIO
from typing import Mapping
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageDraw


def image_bytes(
    image_format: str = "PNG",
    size: tuple[int, int] = (120, 80),
    orientation: int | None = None,
) -> bytes:
    """목적: 회전 확인용 비대칭 사진 생성. 입력: 형식·크기·EXIF 방향. 출력: 이미지 바이트."""
    image = Image.new("RGB", size, (245, 245, 245))
    if min(size) >= 2:
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, size[0] // 2 - 1, size[1] // 2 - 1), fill=(230, 20, 30))
        draw.rectangle((size[0] // 2, 0, size[0] - 1, size[1] // 2 - 1), fill=(20, 210, 40))
        draw.rectangle((0, size[1] // 2, size[0] // 2 - 1, size[1] - 1), fill=(30, 40, 230))
    buffer = BytesIO()
    options = {}
    if orientation is not None:
        exif = Image.Exif()
        exif[274] = orientation
        options["exif"] = exif
    image.save(buffer, format=image_format, **options)
    return buffer.getvalue()


def zip_bytes(entries: Mapping[str, bytes]) -> bytes:
    """목적: 가져오기 검증 자료 생성. 입력: ZIP 상대 경로와 내용. 출력: ZIP 바이트."""
    buffer = BytesIO()
    with ZipFile(buffer, "w", ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def zip_entries(content: bytes) -> dict[str, bytes]:
    """목적: 내보낸 자료를 파일별로 읽기. 입력: ZIP 바이트. 출력: 경로별 파일 내용."""
    with ZipFile(BytesIO(content)) as archive:
        return {name: archive.read(name) for name in archive.namelist()}
