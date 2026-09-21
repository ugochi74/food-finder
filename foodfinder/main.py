"""Dish Finder backend: FastAPI + SQLite + JWT login."""
import hashlib, hmac, json, os, secrets, sqlite3, time
from pathlib import Path

import jwt
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

BASE = Path(__file__).parent
DB_FILE = BASE / "dishes.db"
KEY_FILE = BASE / "secret.key"

# Token signing key: use SECRET_KEY if set, otherwise create one file and reuse it.
SECRET = os.environ.get("SECRET_KEY")
if not SECRET:
    if not KEY_FILE.exists():
        KEY_FILE.write_text(secrets.token_hex(32))
    SECRET = KEY_FILE.read_text().strip()


def query(sql, args=(), write=False):
    con = sqlite3.connect(DB_FILE)
    con.row_factory = sqlite3.Row
    try:
        cur = con.execute(sql, args)
        rows = cur.fetchall()
        con.commit()
        return cur.lastrowid if write else rows
    finally:
        con.close()


def insert_dish(d, owner_id=None):
    return query(
        "INSERT INTO dishes(name,country,type,tags,description,how_eaten,ingredients,nutrition,owner_id)"
        " VALUES(?,?,?,?,?,?,?,?,?)",
        (d["name"], d["country"], d["type"], json.dumps(d["tags"]), d["description"],
         d["how_eaten"], json.dumps(d["ingredients"]), json.dumps(d["nutrition"]), owner_id),
        write=True,
    )


def init():
    con = sqlite3.connect(DB_FILE)
    con.executescript(
        """CREATE TABLE IF NOT EXISTS users(
             id INTEGER PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, pw_hash TEXT NOT NULL);
           CREATE TABLE IF NOT EXISTS dishes(
             id INTEGER PRIMARY KEY, name TEXT NOT NULL, country TEXT NOT NULL, type TEXT, tags TEXT,
             description TEXT, how_eaten TEXT, ingredients TEXT, nutrition TEXT, owner_id INTEGER);"""
    )
    empty = con.execute("SELECT 1 FROM dishes").fetchone() is None
    con.close()
    if empty:  # first run: load the starter dishes
        for d in json.loads((BASE / "seed.json").read_text()):
            insert_dish(d)


init()


def dish(row):
    d = dict(row)
    for key in ("tags", "ingredients", "nutrition"):
        d[key] = json.loads(d[key])
    return d


# ---------- auth helpers ----------
def hash_pw(password, salt):
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def make_token(uid):
    return jwt.encode({"sub": str(uid), "exp": int(time.time()) + 7 * 86400}, SECRET, algorithm="HS256")


def current_user(authorization: str = Header(None)):
    try:
        if not authorization or not authorization.startswith("Bearer "):
            raise ValueError
        uid = int(jwt.decode(authorization[7:], SECRET, algorithms=["HS256"])["sub"])
        rows = query("SELECT id, username FROM users WHERE id=?", (uid,))
        if not rows:
            raise ValueError
    except Exception:
        raise HTTPException(401, "Please log in.")
    return dict(rows[0])


# ---------- request shapes ----------
class Cred(BaseModel):
    username: str = Field(min_length=3, max_length=30, pattern=r"^[A-Za-z0-9_]+$")
    password: str = Field(min_length=8, max_length=128)


class Ingredient(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    quantity: str = Field(default="", max_length=40)


class Nutrition(BaseModel):
    calories: int = Field(ge=0, le=5000)
    protein: float = Field(ge=0, le=1000)
    carbs: float = Field(ge=0, le=1000)
    fat: float = Field(ge=0, le=1000)


class DishIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    country: str = Field(min_length=1, max_length=60)
    type: str = Field(default="", max_length=40)
    description: str = Field(default="", max_length=500)
    how_eaten: str = Field(default="", max_length=500)
    tags: list[str] = Field(default_factory=list, max_length=10)
    ingredients: list[Ingredient] = Field(min_length=1, max_length=40)
    nutrition: Nutrition


# ---------- routes ----------
app = FastAPI(title="Dish Finder")


@app.post("/api/register")
def register(c: Cred):
    salt = secrets.token_hex(16)
    try:
        uid = query("INSERT INTO users(username,salt,pw_hash) VALUES(?,?,?)",
                    (c.username.lower(), salt, hash_pw(c.password, salt)), write=True)
    except sqlite3.IntegrityError:
        raise HTTPException(409, "That username is taken.")
    return {"token": make_token(uid), "username": c.username, "id": uid}


@app.post("/api/login")
def login(c: Cred):
    rows = query("SELECT * FROM users WHERE username=?", (c.username.lower(),))
    if not rows or not hmac.compare_digest(hash_pw(c.password, rows[0]["salt"]), rows[0]["pw_hash"]):
        raise HTTPException(401, "Wrong username or password.")
    return {"token": make_token(rows[0]["id"]), "username": c.username, "id": rows[0]["id"]}


@app.get("/api/countries")
def countries():
    return [r["country"] for r in query("SELECT DISTINCT country FROM dishes ORDER BY country")]


@app.get("/api/dishes")
def search(q: str = "", country: str = "", sort: str = "az"):
    t = q.strip().lower()
    results = []
    for d in map(dish, query("SELECT * FROM dishes")):
        if country and d["country"] != country:
            continue
        fields = [d["name"], d["country"], d["type"], *d["tags"], *[i["name"] for i in d["ingredients"]]]
        if t and not any(t in f.lower() for f in fields):
            continue
        results.append(d)
    keys = {"az": lambda d: d["name"].lower(),
            "cal": lambda d: d["nutrition"]["calories"],
            "pro": lambda d: -d["nutrition"]["protein"]}
    return sorted(results, key=keys.get(sort, keys["az"]))


@app.post("/api/dishes")
def add_dish(body: DishIn, user=Depends(current_user)):
    data = body.model_dump()
    data["tags"] = [t.strip().lower() for t in data["tags"] if t.strip()]
    new_id = insert_dish(data, user["id"])
    return dish(query("SELECT * FROM dishes WHERE id=?", (new_id,))[0])


@app.delete("/api/dishes/{dish_id}")
def delete_dish(dish_id: int, user=Depends(current_user)):
    rows = query("SELECT owner_id FROM dishes WHERE id=?", (dish_id,))
    if not rows:
        raise HTTPException(404, "Dish not found.")
    if rows[0]["owner_id"] != user["id"]:
        raise HTTPException(403, "You can only delete dishes you added.")
    query("DELETE FROM dishes WHERE id=?", (dish_id,), write=True)
    return {"ok": True}


# The website itself. Mounted last so /api routes win.
app.mount("/", StaticFiles(directory=BASE / "static", html=True), name="static")
