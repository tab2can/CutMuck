import { NextRequest, NextResponse } from "next/server";

const WORKER_URL = process.env.WORKER_URL || "http://127.0.0.1:8787";

async function proxy(req: NextRequest, path: string[]) {
  const targetPath = path.join("/");
  const url = new URL(req.url);
  const target = `${WORKER_URL.replace(/\/$/, "")}/${targetPath}${url.search}`;

  const headers = new Headers();
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  const range = req.headers.get("range");
  if (range) headers.set("range", range);
  const cookie = req.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  // Avoid Next↔worker keep-alive storms (HLS segments open dozens of sockets).
  headers.set("connection", "close");

  const init: RequestInit = {
    method: req.method,
    headers,
    cache: "no-store",
    keepalive: false,
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  try {
    const res = await fetch(target, init);
    const outHeaders = new Headers();
    for (const key of [
      "content-type",
      "content-length",
      "content-range",
      "accept-ranges",
      "cache-control",
      "content-disposition",
      "location",
    ]) {
      const value = res.headers.get(key);
      if (value) outHeaders.set(key, value);
    }

    const anyHeaders = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookies =
      typeof anyHeaders.getSetCookie === "function"
        ? anyHeaders.getSetCookie()
        : res.headers.get("set-cookie")
          ? [res.headers.get("set-cookie") as string]
          : [];
    for (const c of setCookies) {
      outHeaders.append("set-cookie", c);
    }

    return new NextResponse(res.body, {
      status: res.status,
      headers: outHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Worker unreachable";
    const cause =
      err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    return NextResponse.json(
      {
        detail: `Worker bağlantısı başarısız (${WORKER_URL}): ${message}${cause}`,
      },
      { status: 502 }
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function PUT(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}

export async function HEAD(req: NextRequest, ctx: Ctx) {
  const { path } = await ctx.params;
  return proxy(req, path);
}
