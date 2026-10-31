import json, logging, os, re, time
from collections import defaultdict, deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import DateTime, Integer, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column

log = logging.getLogger("silversteps")


def db_url() -> str:
    url = os.environ.get("DATABASE_URL")
    if not url:
        for k, v in os.environ.items():
            if re.fullmatch(r"DEPLOYER_DB_.+_URL", k) and v.startswith(("mysql", "mariadb")):
                url = v
                break
    if not url:
        log.warning("No database configured: using SQLite server/local.db, data is NOT persistent")
        return "sqlite:///" + str(Path(__file__).with_name("local.db"))
    return re.sub(r"^(mysql|mariadb)(\+\w+)?://", "mysql+pymysql://", url)


URL = db_url()
IS_SQLITE = URL.startswith("sqlite")
engine = create_engine(URL) if IS_SQLITE else create_engine(
    URL, pool_size=3, max_overflow=2, pool_pre_ping=True, pool_recycle=1800)


class Base(DeclarativeBase):
    pass


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Feedback(Base):
    __tablename__ = "feedback"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    town: Mapped[str] = mapped_column(String(40), index=True)
    segment: Mapped[str] = mapped_column(String(80))
    gap: Mapped[Optional[str]] = mapped_column(String(80), nullable=True)
    barrier: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    verdict: Mapped[str] = mapped_column(String(10))
    note: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created: Mapped[datetime] = mapped_column(DateTime, default=now)


class Route(Base):
    __tablename__ = "routes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    town: Mapped[str] = mapped_column(String(40), index=True)
    destination_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    coords: Mapped[str] = mapped_column(Text)  # JSON text
    created: Mapped[datetime] = mapped_column(DateTime, default=now)


Base.metadata.create_all(engine)

TOWN = r"^[a-z0-9-]{1,40}$"
Barrier = Literal["steps", "crossing", "kerb", "no_shelter", "rest_gap", "surface", "dark", "slope", "obstruction"]
Dest = Literal["hawker", "bus", "park", "supermarket", "mrt", "eldercare", "community", "clinic", "polyclinic"]


class FeedbackIn(BaseModel):
    town: str = Field(pattern=TOWN)
    segment: str = Field(pattern=r"^[0-9]+-[0-9]+-[0-9]+$", max_length=80)
    gap: Optional[str] = Field(None, pattern=r"^[0-9]+:[a-z_]+$", max_length=80)
    barrier: Optional[Barrier] = None
    verdict: Literal["correct", "wrong", "missed"]
    note: Optional[str] = Field(None, max_length=500)

    @field_validator("note")
    @classmethod
    def clean(cls, v):
        return re.sub(r"[\x00-\x1f\x7f]", "", v) if v else v

    def model_post_init(self, _):
        if self.verdict == "missed" and not self.barrier:
            raise ValueError("missed requires barrier")


class RouteIn(BaseModel):
    town: str = Field(pattern=TOWN)
    destination_type: Optional[Dest] = None
    coords: list[tuple[float, float]] = Field(min_length=2, max_length=500)

    @field_validator("coords")
    @classmethod
    def bbox(cls, v):
        for lng, lat in v:
            if not (103.55 <= lng <= 104.15 and 1.15 <= lat <= 1.50):
                raise ValueError("coordinate outside Singapore bbox")
        return [(round(lng, 6), round(lat, 6)) for lng, lat in v]


def iso(d: datetime) -> str:
    return d.isoformat() + "Z"


def fb_out(r: Feedback):
    return {"id": r.id, "town": r.town, "segment": r.segment, "gap": r.gap, "barrier": r.barrier,
            "verdict": r.verdict, "note": r.note, "created": iso(r.created)}


def route_out(r: Route):
    return {"id": r.id, "town": r.town, "destination_type": r.destination_type,
            "coords": json.loads(r.coords), "created": iso(r.created)}


# ponytail: per-process in-memory limiter; resets on restart, not shared across workers
HITS: dict[str, deque] = defaultdict(deque)
LIMIT, WINDOW = 30, 600


def rate_limit(req: Request):
    ip = req.headers.get("x-forwarded-for", "").split(",")[0].strip() or (req.client.host if req.client else "?")
    q, t = HITS[ip], time.monotonic()
    while q and t - q[0] > WINDOW:
        q.popleft()
    if len(q) >= LIMIT:
        raise HTTPException(429, "Too many submissions, try again later")
    q.append(t)


app = FastAPI(title="SilverSteps")
app.add_middleware(GZipMiddleware, minimum_size=1000)  # town segment files are several MB of JSON


@app.get("/api/health")
def health():
    return {"ok": True, "db": "sqlite" if IS_SQLITE else "mariadb"}


@app.get("/api/feedback")
def list_feedback(town: str = Query(pattern=TOWN)):
    with Session(engine) as s:
        rows = s.scalars(select(Feedback).where(Feedback.town == town).order_by(Feedback.id)).all()
        return [fb_out(r) for r in rows]


@app.post("/api/feedback", status_code=201)
def add_feedback(body: FeedbackIn, request: Request):
    rate_limit(request)
    with Session(engine) as s:
        r = Feedback(**body.model_dump())
        s.add(r)
        s.commit()
        return fb_out(r)


@app.get("/api/routes")
def list_routes(town: str = Query(pattern=TOWN)):
    with Session(engine) as s:
        rows = s.scalars(select(Route).where(Route.town == town).order_by(Route.id)).all()
        return [route_out(r) for r in rows]


@app.post("/api/routes", status_code=201)
def add_route(body: RouteIn, request: Request):
    rate_limit(request)
    with Session(engine) as s:
        r = Route(town=body.town, destination_type=body.destination_type, coords=json.dumps(body.coords))
        s.add(r)
        s.commit()
        return route_out(r)


STATIC = Path(os.environ.get("STATIC_DIR") or Path(__file__).parent.parent / "web" / "dist").resolve()


# SPA fallback: serve the file if it exists in dist, else index.html (equivalent to StaticFiles html=True
# plus fallback, but lets us set per-path Cache-Control).
@app.get("/{path:path}", include_in_schema=False)
def spa(path: str):
    if path == "api" or path.startswith("api/"):
        raise HTTPException(404)
    f = (STATIC / path).resolve()
    if not (f.is_file() and f.is_relative_to(STATIC)):
        if path.startswith(("data/", "assets/")):
            raise HTTPException(404)
        f = STATIC / "index.html"
        if not f.is_file():
            raise HTTPException(404)
    p = f.relative_to(STATIC).as_posix()
    if p.startswith("assets/"):
        cc = "public, max-age=31536000, immutable"
    elif p == "index.html" or (p.startswith("data/") and p.endswith(".json")):
        cc = "no-cache"
    else:
        cc = "public, max-age=3600"
    return FileResponse(f, headers={"Cache-Control": cc})
