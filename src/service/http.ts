// Minimal node:http webhook adapter: verifies X-Hub-Signature-256 over the raw
// body before parsing anything, then hands the event to the dispatcher.
// Anything a client does on the wire (reset, stall, oversized body) ends in an
// HTTP error for that request, never in an unhandled rejection that kills the
// service.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { MemoryDeliveryStore, type DeliveryStore } from "./journal.js";

/** GitHub caps webhook payloads at 25 MB. */
export const MAX_BODY_BYTES = 25 * 1024 * 1024;
/** A delivery that has not finished sending its body by then is dropped. */
export const BODY_TIMEOUT_MS = 30_000;

export function signatureFor(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from(signatureFor(secret, body));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface WebhookOptions {
  secret: string;
  dispatch: (event: string, payload: unknown, deliveryId: string) => Promise<unknown>;
  log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Remembered delivery ids, to drop GitHub redeliveries of the same event. */
  dedupeSize?: number;
  /** Persisted seen-delivery keys; defaults to an in-memory store of `dedupeSize` entries. */
  deliveries?: DeliveryStore;
  /** Liveness: `GET /healthz` answers 200 with this when set (listener only, proves nothing else). */
  health?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  maxBodyBytes?: number;
  bodyTimeoutMs?: number;
}

/**
 * X-GitHub-Event is outside the HMAC, so a captured body must not be
 * replayable as another event: the payload has to have that event's shape.
 */
const EVENT_SHAPES: Record<string, (p: Record<string, unknown>) => boolean> = {
  pull_request: (p) => isObj(p.pull_request) && isObj(p.repository),
  merge_group: (p) => isObj(p.merge_group) && isObj(p.repository),
  issue_comment: (p) => isObj(p.comment) && isObj(p.issue) && isObj(p.repository),
};

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function payloadMatchesEvent(event: string, payload: unknown): boolean {
  if (!isObj(payload)) return false;
  const shape = EVENT_SHAPES[event];
  if (shape) return shape(payload);
  // Events the dispatcher ignores must not look like one it acts on.
  return !Object.values(EVENT_SHAPES).some((f) => f(payload));
}

type BodyResult = { ok: true; body: Buffer } | { ok: false; status: 400 | 408 | 413; why: string };

function readBody(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (r: BodyResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeAllListeners("data");
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, status: 408, why: "body timeout" }), timeoutMs);
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      finish({ ok: false, status: 413, why: "declared body too large" });
      return;
    }
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        finish({ ok: false, status: 413, why: "body too large" });
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on("aborted", () => finish({ ok: false, status: 400, why: "client aborted" }));
    req.on("error", (e) => finish({ ok: false, status: 400, why: `request error: ${String(e)}` }));
    req.on("close", () => finish({ ok: false, status: 400, why: "connection closed before body end" }));
  });
}

function reply(res: ServerResponse, status: number, body = ""): void {
  if (res.headersSent || res.destroyed) return;
  // Close the connection on errors: the rest of the body is never read.
  res.writeHead(status, status >= 400 ? { connection: "close" } : {}).end(body);
}

/**
 * Returns a request handler. The returned promise resolves after dispatch
 * finishes so tests can await processing; the HTTP response is sent first.
 * The promise never rejects.
 */
export function createWebhookHandler(opts: WebhookOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const deliveries = opts.deliveries ?? new MemoryDeliveryStore((opts.dedupeSize ?? 5000) * 2);
  const maxBytes = opts.maxBodyBytes ?? MAX_BODY_BYTES;
  const timeoutMs = opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.on("error", (e) => opts.log?.("response error", { error: String(e) }));
    if (req.method === "GET" && req.url === "/healthz" && opts.health) {
      const body = JSON.stringify({ ok: true, ...(await opts.health()) });
      if (!res.headersSent) res.writeHead(200, { "content-type": "application/json" }).end(body);
      return;
    }
    if (req.method !== "POST") {
      reply(res, 405);
      return;
    }
    const read = await readBody(req, maxBytes, timeoutMs);
    if (!read.ok) {
      opts.log?.("webhook body rejected", { why: read.why });
      reply(res, read.status);
      if (read.status !== 400) req.destroy();
      return;
    }
    const body = read.body;
    const sig = req.headers["x-hub-signature-256"];
    if (!verifySignature(opts.secret, body, Array.isArray(sig) ? sig[0] : sig)) {
      reply(res, 401);
      return;
    }
    const event = String(req.headers["x-github-event"] ?? "");
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      reply(res, 400);
      return;
    }
    if (!payloadMatchesEvent(event, payload)) {
      opts.log?.("webhook event/payload mismatch", { event, delivery });
      reply(res, 400);
      return;
    }
    // Dedupe on the delivery id and on the signed body: a replay under a new id is the same event.
    const bodyKey = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    if ((delivery && (await deliveries.has(delivery))) || (await deliveries.has(bodyKey))) {
      reply(res, 200, "duplicate");
      return;
    }
    await deliveries.add(delivery ? [delivery, bodyKey] : [bodyKey]);
    reply(res, 202);
    try {
      await opts.dispatch(event, payload, delivery);
    } catch (e) {
      opts.log?.("dispatch failed", { event, delivery, error: String(e) });
    }
  };
  return (req, res) =>
    handle(req, res).catch((e) => {
      opts.log?.("webhook handler failed", { error: String(e) });
      reply(res, 500);
    });
}

export function createWebhookServer(opts: WebhookOptions): Server {
  const handler = createWebhookHandler(opts);
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  // Bound slow-loris style stalls at the socket level too.
  server.requestTimeout = (opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS) + 5_000;
  server.headersTimeout = 20_000;
  server.on("clientError", (_err, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });
  return server;
}
