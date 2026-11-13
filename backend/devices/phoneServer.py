from __future__ import annotations

import socket


def openListenSocket(host: str, port: int) -> socket.socket | None:
    listenSocket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        listenSocket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listenSocket.bind((host, port))
    except OSError:
        listenSocket.close()
        return None

    return listenSocket


def serveOnSockets(listenSockets: list[socket.socket], port: int) -> None:
    import uvicorn

    config = uvicorn.Config("backend.main:app", host="127.0.0.1", port=port)
    uvicorn.Server(config).run(sockets=listenSockets)
