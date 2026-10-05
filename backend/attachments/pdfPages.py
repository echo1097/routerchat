from __future__ import annotations

import re
import zlib

OBJECT_START = re.compile(rb"(\d+)\s+\d+\s+obj\b")
STREAM_START = re.compile(rb"stream\r?\n")
PAGE_TYPE = re.compile(rb"/Type\s*/Page(?![A-Za-z])")
OBJECT_STREAM_TYPE = re.compile(rb"/Type\s*/ObjStm\b")
FLATE_FILTER = re.compile(rb"/Filter\s*(\[\s*)?/FlateDecode\b")
OBJECT_COUNT = re.compile(rb"/N\s+(\d+)")
FIRST_OFFSET = re.compile(rb"/First\s+(\d+)")
ENCRYPTED = re.compile(rb"/Encrypt\b")


def inflate(data: bytes) -> bytes | None:
    try:
        return zlib.decompressobj().decompress(data)
    except zlib.error:
        return None


def packedObjects(dictionary: bytes, streamData: bytes) -> dict[int, bytes]:
    if FLATE_FILTER.search(dictionary):
        inflated = inflate(streamData)
        if inflated is None:
            return {}
        streamData = inflated

    countMatch = OBJECT_COUNT.search(dictionary)
    firstMatch = FIRST_OFFSET.search(dictionary)
    if not countMatch or not firstMatch:
        return {}

    objectCount = int(countMatch.group(1))
    first = int(firstMatch.group(1))
    header = streamData[:first].split()
    if len(header) < objectCount * 2:
        return {}

    try:
        numbers = [int(value) for value in header[: objectCount * 2 : 2]]
        offsets = [int(value) for value in header[1 : objectCount * 2 : 2]]
    except ValueError:
        return {}

    objects: dict[int, bytes] = {}
    for index, number in enumerate(numbers):
        start = first + offsets[index]
        end = first + offsets[index + 1] if index + 1 < objectCount else len(streamData)
        objects[number] = streamData[start:end]
    return objects


def countPdfPages(raw: bytes) -> int | None:
    if not raw.startswith(b"%PDF") or ENCRYPTED.search(raw):
        return None

    isPage: dict[int, bool] = {}
    position = 0

    while True:
        objectMatch = OBJECT_START.search(raw, position)
        if not objectMatch:
            break

        number = int(objectMatch.group(1))
        bodyStart = objectMatch.end()
        objectEnd = raw.find(b"endobj", bodyStart)
        if objectEnd == -1:
            objectEnd = len(raw)

        streamMatch = STREAM_START.search(raw, bodyStart, objectEnd)
        if not streamMatch:
            isPage[number] = bool(PAGE_TYPE.search(raw, bodyStart, objectEnd))
            position = objectEnd
            continue

        dictionary = raw[bodyStart : streamMatch.start()]
        streamEnd = raw.find(b"endstream", streamMatch.end())
        if streamEnd == -1:
            streamEnd = len(raw)

        isPage[number] = False
        if OBJECT_STREAM_TYPE.search(dictionary):
            packed = packedObjects(dictionary, raw[streamMatch.end() : streamEnd])
            for packedNumber, body in packed.items():
                isPage[packedNumber] = bool(PAGE_TYPE.search(body))

        position = streamEnd

    pageCount = sum(isPage.values())
    return pageCount or None
