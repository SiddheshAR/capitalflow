# Keycloak and BFF setup for local development

This guide records the authentication setup used by Capitalflow. It is written so the local environment can be rebuilt from scratch. The names and URLs below are **identifiers**, not passwords. Keep real passwords and the client secret in local `.env` files; do not commit them.

## What each part does

| Part | Local address | Job |
| --- | --- | --- |
| Keycloak | `http://localhost:8080` | Authenticates the user and issues OpenID Connect (OIDC) tokens. |
| Realm | `investment-dev` | Isolates this project's users, clients, and login settings. Its name appears in the issuer URL. |
| BFF client | `investment-bff` | The Keycloak registration for the Nest BFF application. Its client ID is **not** the realm name. |
| BFF | `http://localhost:3000` | Starts login, handles the callback, and keeps tokens on the server. |
| Redis | `redis://localhost:6379` | Stores BFF session data, including the temporary login transaction and the signed-in user. |
| Access API audience | `investment-access-api` | Identifies the intended API in a Keycloak access token's `aud` claim. |

The browser ultimately receives a BFF session cookie named `bff.sid`. It does **not** receive the BFF's access token from this implementation. Keycloak also maintains its own browser login session, which is why starting `/auth/login` again can sign the user in without another password prompt.

## 1. Start the local services

From the repository root, put local passwords in the root `.env`, following the variable names in [`.env.example`](../.env.example):

```dotenv
ACCESS_DB_PASSWORD=<your-local-access-db-password>
KEYCLOAK_DB_PASSWORD=<your-local-keycloak-db-password>
KEYCLOAK_ADMIN_PASSWORD=<your-local-keycloak-admin-password>
```

Start Docker services:

```powershell
docker compose up -d
docker compose ps
```

[`compose.yaml`](../compose.yaml) starts Keycloak, its PostgreSQL database, the separate Access PostgreSQL database, and Redis. The Keycloak bootstrap admin username is `admin`; its password comes from `KEYCLOAK_ADMIN_PASSWORD`. Open `http://localhost:8080/admin/` and sign in. For this local setup, Keycloak runs in `start-dev` mode over HTTP.

> The bootstrap admin belongs to Keycloak administration. It is separate from the ordinary test user created below. The yellow “temporary admin user” banner is about that bootstrap admin account.

## 2. Create the realm

1. In the Keycloak Admin Console, open the realm selector at the upper left. It initially shows `master`.
2. Select **Create realm** (or **Manage realms → Create realm**, depending on the console view).
3. Set **Realm name** to exactly `investment-dev`, leave it enabled, and select **Create**.
4. Check that the realm selector now shows `investment-dev`.
5. Open `http://localhost:8080/realms/investment-dev/.well-known/openid-configuration` in a browser. It should return JSON with an `issuer` value of `http://localhost:8080/realms/investment-dev`.

The realm name is part of a URL and must match exactly. `investment-dev-realm` is a different value. A client with that name inside `master` does not create a realm.

## 3. Create the BFF client inside that realm

First confirm that the realm selector still says `investment-dev`. Then go to **Clients → Create client**.

### General settings

1. Select **OpenID Connect** as the client type.
2. Set **Client ID** to exactly `investment-bff`.
3. Continue to **Capability config**.

### Capability config

1. Turn **Client authentication** **On**. The BFF is a server application and will use a client secret when it exchanges the authorization code for tokens.
2. Enable **Standard flow** (the authorization code flow).
3. Leave **Implicit flow**, **Direct access grants**, and **Service accounts roles** off for this login flow. Leave **Authorization** off if offered.
4. Continue to **Login settings**.

### Login settings

| Field | Value |
| --- | --- |
| Root URL | Leave blank |
| Home URL | Leave blank |
| Valid redirect URIs | `http://localhost:3000/auth/callback` |
| Valid post logout redirect URIs | `http://localhost:3000/` |
| Web origins | Leave blank for the current server-side redirect flow |

Save/create the client. The redirect URI must match the BFF setting exactly, including port and path. Keycloak sends the user's browser back to this URL after login; it does not call the BFF callback directly from the Keycloak server.

Open the new client's **Credentials** tab and copy its client secret into `apps/bff/.env` as `OIDC_CLIENT_SECRET`. Never paste that secret into documentation or commit it.

If the client has an **Advanced** setting named **PKCE method**, choose `S256`. The BFF code sends an `S256` code challenge during login even if that setting does not appear in the console. The Keycloak setting, when available, makes `S256` mandatory for this client.

## 4. Create a local test user

1. With `investment-dev` selected, open **Users → Create new user**.
2. Set **Username** to `sidh.dev`. Add the user's email, first name, and last name as desired. Save.
3. Open the user and select **Credentials → Set password**.
4. Enter a local test password and set **Temporary** to **Off** if you want to use that password without a forced change on first login.

This user signs in on the Keycloak login page. It is not the Keycloak admin account and is not the `investment-bff` client.

## 5. Configure the BFF

Create `apps/bff/.env` from [`apps/bff/.env.example`](../apps/bff/.env.example), then replace the placeholders with your own values:

```dotenv
PORT=3000
OIDC_ISSUER=http://localhost:8080/realms/investment-dev
OIDC_CLIENT_ID=investment-bff
OIDC_CLIENT_SECRET=<secret-from-the-client-credentials-tab>
OIDC_REDIRECT_URI=http://localhost:3000/auth/callback
REDIS_URL=redis://localhost:6379
SESSION_SECRET=<a-long-random-local-secret-at-least-32-characters>
```

The `OIDC_ISSUER` contains the **realm** name; `OIDC_CLIENT_ID` contains the **client** ID. `SESSION_SECRET` signs the BFF session cookie and is separate from `OIDC_CLIENT_SECRET`.

From the repository root, start the BFF:

```powershell
cd apps/bff
pnpm run start:dev
```

The BFF loads `apps/bff/.env` when started from its directory. At startup, [`main.ts`](../apps/bff/src/main.ts) connects to Redis and registers `express-session` with a Redis store. It uses an HTTP-only, SameSite `lax` cookie named `bff.sid`; `secure: false` is for local HTTP. In an HTTPS deployment, revisit the cookie and proxy settings.

## 6. Test the login flow

Use the **same browser tab/profile** for the whole flow, starting at:

```text
http://localhost:3000/auth/login
```

What happens, in order:

1. [`AuthController.login()`](../apps/bff/src/auth.controller.ts) discovers the Keycloak endpoints using `OIDC_ISSUER`.
2. The BFF creates a short-lived login transaction containing `state`, `nonce`, and a PKCE code verifier. It saves that transaction in the Redis-backed session, then redirects the browser to Keycloak with a PKCE `S256` challenge.
3. The browser shows the Keycloak login page. Sign in as `sidh.dev`. Keycloak authenticates the user and redirects the browser to `http://localhost:3000/auth/callback` with a short-lived authorization code and `state`.
4. [`AuthController.callback()`](../apps/bff/src/auth.controller.ts) reads the temporary transaction from the session, checks the returned `state` and expected `nonce`, and uses the saved PKCE verifier plus the client credentials to exchange the code with Keycloak for tokens. The temporary transaction is consumed so it cannot be reused.
5. The BFF rotates the session ID, then stores the user's Keycloak subject, optional email/name, and access token in the server-side Redis session. The browser receives only the BFF's session cookie.
6. The callback redirects the browser to `/api/me`. [`ApiController.getMe()`](../apps/bff/src/api.controller.ts) reads the user from the BFF session and returns basic user data. It returns `401` when there is no signed-in BFF session.

The temporary login cookie and the signed-in cookie both use `bff.sid`, but the session ID is replaced after successful login. Keycloak's own login cookie is separate; it lets Keycloak recognize the user on later visits to its login page.

You can also open `http://localhost:3000/health/live` to check that the BFF responds. This is a health endpoint, not an authentication test.

## 7. Add the Access API audience mapper

This is the Keycloak change made for the Day 3 Access API work. While the `investment-dev` realm is selected:

1. Open **Clients → investment-bff → Client scopes**.
2. Open the dedicated scope named `investment-bff-dedicated` (the console may describe it as the dedicated scope and mappers for this client).
3. Open **Mappers → Configure a new mapper → Audience**.
4. Set the mapper name to `access-api-audience`.
5. Leave **Included Client Audience** empty and set **Included Custom Audience** to `investment-access-api`.
6. Turn **Add to access token** on and **Add to ID token** off. Save.

This adds `investment-access-api` to the `aud` claim of access tokens issued for this BFF client. The value is an audience identifier; it does not have to be another Keycloak client. The Access service configuration expects `OIDC_ISSUER=http://localhost:8080/realms/investment-dev` and `OIDC_AUDIENCE=investment-access-api` in the repository-root `.env`. At this stage, these Access settings have been added, but Access token verification is part of the subsequent API implementation.

## Common problems we hit

| Symptom | Check |
| --- | --- |
| Discovery returns `404` for `/realms/investment-bff/.well-known/openid-configuration` | `investment-bff` is the client, not the realm. Set `OIDC_ISSUER` to `/realms/investment-dev`. |
| Keycloak says **Client not found** | Confirm that `investment-bff` exists **inside `investment-dev`**, and that `OIDC_CLIENT_ID` matches it exactly. A similarly named client in `master` is unrelated. |
| Keycloak says the redirect URI is invalid | Compare the client's **Valid redirect URIs** entry with `OIDC_REDIRECT_URI` exactly: `http://localhost:3000/auth/callback`. |
| BFF says **Login was not started or has expired** | Start again at `/auth/login`. Do not open or reuse `/auth/callback` directly: it needs the fresh session, `state`, and one-time code from the same login attempt. Check that Redis is running. |
| Browser goes to `/auth/callback` but Nest says **Cannot GET** | Ensure the BFF version with `AuthController.callback()` is running on port `3000`; restart it after code changes. |
| `/api/me` says **Cannot GET** | Ensure `ApiController` is registered in the BFF `AppModule` and the current BFF is running. |
| `/api/me` returns `401` | The browser has no valid BFF session. Start at `/auth/login`. |
| Removing the BFF cookie still signs in automatically | The Keycloak SSO cookie can still be present. Removing one cookie does not log the browser out of Keycloak. |
| OIDC discovery rejects local HTTP | This BFF allows insecure requests only when the issuer is `http://localhost`. Production issuers should use HTTPS. |

## Keep these boundaries clear

- **Realm**: `investment-dev`; appears in the issuer URL.
- **Client**: `investment-bff`; identifies the BFF to Keycloak and has a client secret.
- **User**: `sidh.dev`; enters credentials on Keycloak's page.
- **Keycloak authorization code**: short-lived value returned through the browser to the BFF callback; it is not the access token.
- **BFF session ID**: opaque value in the browser's `bff.sid` cookie; it points to server-side Redis data.
- **Access token**: obtained by the BFF from Keycloak and held in its server-side session. The later Access API work will verify issuer, signature, expiry, and audience before trusting it.

For the Keycloak console fields and their meaning, see the [Keycloak Server Administration Guide](https://www.keycloak.org/docs/26.0.8/server_admin/). For the audience mapper fields, see the [Keycloak protocol mapper reference](https://www.keycloak.org/admin-api/protocol-mappers).
