# Microsoft 365-inloggning (SSO) — registrera Simba i er Entra-tenant

En skärm-för-skärm-guide som ger dig de två värdena jag behöver för att slå på
inloggningen: **Application (client) ID** och **Directory (tenant) ID**.
Du behöver vara **Global Administrator** (eller Application Administrator).

> Host i exemplen: `mineral-qd8c.onrender.com` — byt ut mot er riktiga host.

---

## 1. Registrera appen
1. Gå till **https://entra.microsoft.com** → **Identity → Applications → App registrations** → **New registration**.
2. **Name:** `Simba AI`
3. **Supported account types:** *Accounts in this organizational directory only* (Single tenant).
4. **Redirect URI:** välj plattform **Single-page application (SPA)** och ange
   `https://mineral-qd8c.onrender.com/taskpane.html`
5. Klicka **Register**.
6. På översiktssidan: **kopiera "Application (client) ID" och "Directory (tenant) ID"** — det är de två värdena jag behöver. 📋

## 2. Lägg till fler redirect-URI:er (SPA)
Under **Authentication → Single-page application → Add URI**, lägg till:
- `https://mineral-qd8c.onrender.com/` (webb/PWA)
- `https://mineral-qd8c.onrender.com/dialog.html` (om dialog-fallback används)
- (om ni kör Outlook-tillägget) samma host fungerar — `/taskpane.html` används av båda.

Lämna *Access tokens* och *ID tokens* som de är (SPA använder PKCE).

## 3. Exponera ett API + scope
1. **Expose an API → Application ID URI → Set** →
   `api://mineral-qd8c.onrender.com/<CLIENT_ID>`  (klistra in client-id från steg 1).
2. **Add a scope:**
   - Scope name: **`access_as_user`**
   - Who can consent: **Admins and users**
   - Admin consent display name: `Access Simba as the signed-in user`
   - State: **Enabled** → **Add scope**.

## 4. Förauktorisera Office-klienterna
Fortfarande under **Expose an API → Authorized client applications → Add a client application**.
Lägg till **var och en** av dessa app-id:n och bocka i `access_as_user`-scopet
(detta är Microsofts välkända Office-klient-id:n så att Excel/Office kan logga in tyst):

```
ea5a67f6-b6f3-4338-b240-c655ddc3cc8e   Microsoft Office
d3590ed6-52b3-4102-aeff-aad2292ab01c   Microsoft Office
57fb890c-0dab-4253-a5e0-7188c88b2bb4   Office on the web
08e18876-6177-487e-b8b5-cf950c1e598c   Office on the web
93d53678-613d-4013-afc1-62e9e444a0a5   Office on the web
bc59ab01-8403-45c6-8796-ac3ef710b3e3   Outlook (om relevant)
```

## 5. API-behörigheter (Microsoft Graph, delegated)
**API permissions → Add a permission → Microsoft Graph → Delegated**, lägg till:
- `openid`, `profile`, `offline_access`, `User.Read`
- (för Outlook-mejl: läsa/söka/skicka) **`Mail.Read`** och **`Mail.Send`**
- (valfritt, för molnfiler) `Files.Read`
- (valfritt, för schemalagda jobb som redigerar filer) **Application**-behörigheten
  `Files.ReadWrite.All`, och `Mail.Send` om jobben ska maila resultat.
Klicka sedan **Grant admin consent for <din org>**.

## 6. Client secret (för molnfiler/Graph)
**Certificates & secrets → New client secret** → kopiera **värdet** direkt
(visas bara en gång). Det sätts som env på servern, **aldrig i koden/repot**.

---

## Skicka tillbaka det här till mig
- **Application (client) ID:** `________`
- **Directory (tenant) ID:** `________`
- **Host** (om inte `mineral-qd8c.onrender.com`): `________`

Då genererar jag `manifest.prod.xml` (med SSO-blocket ifyllt) och env-blocket.
Hemligheten (`AAD_CLIENT_SECRET`) lägger **du** in i Render-dashboarden — den ska
aldrig i repot.

## Installera Simba i Outlook (valfritt)

Simba kan köras som ett **Outlook-tillägg** (utöver Excel) — då bor assistenten i
Outlook och kan läsa/sammanfatta mejl, skriva utkast och nå kunskapsbanken direkt.

1. **Generera Outlook-manifestet** (samma host + samma client-id som ovan):
   ```
   npm run manifest -- --outlook --base https://DIN_HOST --aad <CLIENT_ID> --new-id --out manifest.outlook.prod.xml
   ```
2. **Distribuera:** M365 admin center → **Inställningar → Integrerade appar → Ladda upp anpassad app** → ladda upp `manifest.outlook.prod.xml` → tilldela användare/grupp. (Excel- och Outlook-tilläggen är två separata manifest mot samma host — ladda upp båda.)
3. I Outlook dyker en **"Öppna Simba"-knapp** upp i menyfliken när man läser eller skriver ett mejl. Inloggning och allt annat delas med övriga ytor.

> Behörighet: Outlook-manifestet begär `ReadItem`. Själva mejl-läsning/skick sker
> via Graph (`Mail.Read`/`Mail.Send`) som du redan gett medgivande till i steg 5.

## Verifiera när allt är på plats
- Servern: env `AAD_CLIENT_ID`, `AAD_TENANT`, ev. `AAD_CLIENT_SECRET`, `DATABASE_URL`.
- Ladda upp `manifest.prod.xml` i **M365 admin center → Integrerade appar** och tilldela.
- Öppna `https://DIN_HOST/api/health` → `"ssoConfigured": true`.
- I Simba: **Inställningar → Minne → Logga in** (eller automatisk tyst inloggning i Excel).
