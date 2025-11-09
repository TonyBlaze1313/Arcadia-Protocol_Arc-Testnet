from fastapi import FastAPI
from .watcher import start_watcher
from . import timelock_api
import asyncio

app = FastAPI(title="Arcadia AI Backend")

@app.on_event("startup")
async def startup_event():
    # start background event watcher
    asyncio.create_task(start_watcher())

# include timelock API router (protected by simple API key header)
app.include_router(timelock_api.router)

@app.get("/health")
async def health():
    return {"status": "ok"}
