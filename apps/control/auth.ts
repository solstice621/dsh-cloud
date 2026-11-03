import type { IncomingMessage, ServerResponse } from "node:http";
import * as oidc from "openid-client";
import { z } from "zod";
import {
  digest,
  equalSecret,
  id,
  secret,
  requireValue,
  CloudError,
} from "../../packages/contracts/index.ts";
import { Store } from "./db.ts";
import type { ControlConfig } from "./config.ts";
import { body, cookie, json, RateLimit } from "./http.ts";

export class Auth {
  private oidcConfig?: Promise<oidc.Configuration>;
  private retryAt = 0;
  private discoveryFailures = 0;
  readonly limits = new RateLimit();
  constructor(
    readonly store: Store,
    readonly config: ControlConfig,
  ) {}
  private discover() {
    const c = this.config.oidc!;
    return oidc.discovery(
      new URL(c.issuer),
      c.clientId,
      c.clientSecret,
    );
  }
  private client() {
    if (this.oidcConfig) return this.oidcConfig;
    if (Date.now() < this.retryAt)
      return Promise.reject(new CloudError(503, "OIDC_UNAVAILABLE", "Identity provider is temporarily unavailable; retry shortly"));
    const pending = this.discover().then(config => {
      this.discoveryFailures = 0;
      this.retryAt = 0;
      return config;
    }).catch(error => {
      if (this.oidcConfig === pending) this.oidcConfig = undefined;
      this.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** this.discoveryFailures++);
      throw error;
    });
    this.oidcConfig = pending;
    return pending;
  }
  sessionCookie(token: string, maxAge = 86400) {
    return `dsh_cloud=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${this.config.publicUrl.startsWith("https:") ? "; Secure" : ""}`;
  }
  authenticate(
    req: IncomingMessage,
    kind: "owner" | "runner" | "executor" | "model" = "owner",
  ) {
    const bearer = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : undefined;
    const token =
      bearer ??
      (kind === "model" ? String(req.headers["x-api-key"] ?? "") : undefined) ??
      cookie(req, "dsh_cloud") ??
      "";
    if (
      kind === "owner" &&
      this.config.development &&
      bearer &&
      this.config.devToken &&
      equalSecret(bearer, this.config.devToken)
    )
      return {
        kind: "owner",
        subject: this.config.ownerId,
        token,
        scope: null,
      };
    const c = this.store.auth(token);
    requireValue(
      c.kind === (kind === "model" ? "executor" : kind),
      "WRONG_CREDENTIAL",
      "Credential cannot perform this operation",
      403,
    );
    if (kind === "owner") {
      requireValue(
        c.subject === this.config.ownerId,
        "OWNER_REQUIRED",
        "Account is not enabled",
        403,
      );
      if (!bearer && !["GET", "HEAD"].includes(req.method ?? ""))
        requireValue(
          req.headers.origin === this.config.publicUrl,
          "CSRF_ORIGIN",
          "Request origin does not match the service",
          403,
        );
    }
    if (kind === "runner")
      requireValue(
        this.store.one<any>("SELECT revoked FROM runners WHERE id=?", c.subject)
          ?.revoked === 0,
        "RUNNER_REVOKED",
        "Runner was revoked",
        403,
      );
    if (kind === "executor" || kind === "model")
      this.store.fence(c.subject, c.scope.epoch, c.scope.incarnation);
    return { ...c, token };
  }
  async routes(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname,
      method = req.method;
    if (path === "/auth/login" && method === "GET") {
      requireValue(
        this.config.oidc,
        "OIDC_NOT_CONFIGURED",
        "Use development sign-in on this local service",
        400,
      );
      const client = await this.client(),
        verifier = oidc.randomPKCECodeVerifier(),
        state = oidc.randomState(),
        nonce = oidc.randomNonce();
      const requestedReturn = url.searchParams.get("returnTo") ?? "/";
      const returnTo = /^\/(?:\?device=[a-f0-9-]{36})?$/.test(requestedReturn)
        ? requestedReturn
        : "/";
      this.store.exec(
        "INSERT INTO auth_flows VALUES (?,?,?)",
        state,
        JSON.stringify({ verifier, nonce, returnTo }),
        Date.now() + 600000,
      );
      const login = oidc.buildAuthorizationUrl(client, {
        redirect_uri: this.config.publicUrl + "/auth/callback",
        scope: "openid profile",
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: "S256",
        state,
        nonce,
      });
      res.setHeader(
        "set-cookie",
        `dsh_login=${state}; HttpOnly; SameSite=Lax; Secure; Path=/auth; Max-Age=600`,
      );
      res.writeHead(302, { location: login.href }).end();
      return true;
    }
    if (path === "/auth/callback" && method === "GET") {
      const state = url.searchParams.get("state") ?? "";
      requireValue(
        equalSecret(state, cookie(req, "dsh_login") ?? ""),
        "LOGIN_STATE",
        "Login state mismatch",
        400,
      );
      const row = this.store.one<any>(
        "SELECT * FROM auth_flows WHERE id=? AND expiresAt>?",
        state,
        Date.now(),
      );
      requireValue(row, "LOGIN_EXPIRED", "Restart sign-in", 400);
      this.store.exec("DELETE FROM auth_flows WHERE id=?", state);
      const flow = JSON.parse(row.body);
      const tokenSet = await oidc.authorizationCodeGrant(
        await this.client(),
        new URL(req.url!, this.config.publicUrl),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: state,
          expectedNonce: flow.nonce,
        },
      );
      requireValue(
        tokenSet.claims()?.sub === this.config.oidc!.ownerSubject,
        "OWNER_REQUIRED",
        "This account is not enabled",
        403,
      );
      const token = this.store.mint("owner", this.config.ownerId);
      res.setHeader("set-cookie", [
        this.sessionCookie(token),
        "dsh_login=; HttpOnly; SameSite=Lax; Secure; Path=/auth; Max-Age=0",
      ]);
      res.writeHead(302, { location: flow.returnTo ?? "/" }).end();
      return true;
    }
    if (path === "/auth/development" && method === "POST") {
      requireValue(this.config.development, "NOT_FOUND", "Not found", 404);
      this.limits.check("dev:" + req.socket.remoteAddress, 10);
      requireValue(
        req.headers.origin === this.config.publicUrl,
        "CSRF_ORIGIN",
        "Origin mismatch",
        403,
      );
      const data = z
        .object({ token: z.string().max(300) })
        .strict()
        .parse(await body(req));
      requireValue(
        equalSecret(data.token, this.config.devToken ?? ""),
        "UNAUTHORIZED",
        "Invalid development token",
        401,
      );
      res.setHeader(
        "set-cookie",
        this.sessionCookie(this.store.mint("owner", this.config.ownerId)),
      );
      json(res, { ok: true });
      return true;
    }
    if (path === "/auth/logout" && method === "POST") {
      const c = this.authenticate(req);
      this.store.exec(
        "UPDATE credentials SET revoked=1 WHERE hash=?",
        digest(c.token),
      );
      res.setHeader("set-cookie", this.sessionCookie("", 0));
      json(res, { ok: true });
      return true;
    }
    if (path === "/auth/device" && method === "POST") {
      this.limits.check("device:" + req.socket.remoteAddress, 10);
      const deviceId = id(),
        code = secret().slice(0, 10).toUpperCase(),
        pollToken = secret();
      this.store.exec(
        "INSERT INTO devices VALUES (?,?,?,NULL,?,?)",
        deviceId,
        digest(code),
        digest(pollToken),
        "pending",
        Date.now() + 600000,
      );
      json(
        res,
        {
          deviceId,
          userCode: code,
          pollToken,
          verificationUri: this.config.publicUrl + "/?device=" + deviceId,
          expiresIn: 600,
          interval: 5,
        },
        201,
      );
      return true;
    }
    if (path === "/auth/device/approve" && method === "POST") {
      const c = this.authenticate(req);
      const data = z
        .object({ deviceId: z.string().uuid(), userCode: z.string().max(20) })
        .strict()
        .parse(await body(req));
      const changed = this.store.exec(
        "UPDATE devices SET ownerId=?,state='approved' WHERE id=? AND codeHash=? AND state='pending' AND expiresAt>?",
        c.subject,
        data.deviceId,
        digest(data.userCode.toUpperCase()),
        Date.now(),
      ).changes;
      requireValue(
        changed === 1,
        "DEVICE_EXPIRED",
        "Device code expired or already used",
      );
      json(res, { ok: true });
      return true;
    }
    if (path === "/auth/device/token" && method === "POST") {
      this.limits.check("device-poll:" + req.socket.remoteAddress, 30);
      const data = z
        .object({ deviceId: z.string().uuid(), pollToken: z.string() })
        .strict()
        .parse(await body(req));
      const d = this.store.one<any>(
        "SELECT * FROM devices WHERE id=? AND pollHash=? AND expiresAt>?",
        data.deviceId,
        digest(data.pollToken),
        Date.now(),
      );
      requireValue(d, "DEVICE_EXPIRED", "Device pairing expired", 400);
      if (d.state === "pending") {
        json(res, { state: "pending" });
        return true;
      }
      const result = this.store.idempotent(
        "device-token",
        digest(data.pollToken),
        data,
        () => {
          requireValue(
            d.state === "approved",
            "DEVICE_USED",
            "Device pairing already consumed",
          );
          this.store.exec("UPDATE devices SET state='used' WHERE id=?", d.id);
          return {
            state: "approved",
            token: this.store.mint(
              "owner",
              d.ownerId,
              { deviceId: d.id },
              30 * 86400000,
            ),
          };
        },
      );
      json(res, result);
      return true;
    }
    return false;
  }
}
