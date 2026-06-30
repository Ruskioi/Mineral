# Simba AI — lanseringschecklista

En stegvis runbook för att ta Simba i skarp drift. Ordningen är medveten:
**få backend i drift → slå på inloggning → lansera webben → rulla ut Excel →
(valfritt) skrivbordsappen.** Varje steg har ett verifieringssteg så du vet att
det funkar innan du går vidare.

Djupare detaljer finns i [`DEPLOYMENT.md`](./DEPLOYMENT.md) och
[`../desktop/README.md`](../desktop/README.md); den här filen är ordningen att
göra det i.

---

## 0. Innan du börjar

- [ ] Anthropic API-nyckel (https://console.anthropic.com)
- [ ] Ett hosting-konto (Render rekommenderas — repo har en `render.yaml`)
- [ ] För inloggning/molnfiler/scheman: rätt att registrera en **Entra ID
      (Azure AD)-app** i er Microsoft 365-tenant
- [ ] `npm run check` grönt lokalt (kör tester + bygge)

---

## 1. Hosta backend (obligatoriskt)

Simba körs som **en tjänst på ett origin** — samma Node-app serverar gränssnittet
*och* `/api`. API-nyckeln stannar på servern.

- [ ] Render → **New + → Blueprint** → peka på repot (använder `render.yaml`:
      Docker, `healthCheckPath: /api/health`).
- [ ] Välj **betald instans** (`starter` eller högre). Free-nivån somnar vid
      inaktivitet → kalla starter som kan ge "fel vid inläsning" i Excel.
- [ ] Sätt hemligheten `ANTHROPIC_API_KEY` i Render-dashboarden (commit:a den ALDRIG).
- [ ] Valfria knappar (se [`.env.example`](../.env.example)): `SIMBA_SPEED`,
      `SIMBA_IP_RPM`, `SIMBA_MODEL`, `SIMBA_MODEL_SIMPLE`, `SIMBA_ROUTER`.

**Verifiera:** öppna `https://DITT_HOST/api/health` →
`{"ok":true,"keyConfigured":true,"model":"claude-opus-4-8", …}`.

---

## 2. Inloggning + minne + synk (rekommenderas)

Ger per-användarminne och chatthistorik som följer användaren mellan webb, Excel
och dator. Kräver en Entra ID-app + en Postgres-databas.

- [ ] **Registrera en Entra ID-app** (Entra admin center → App registrations).
      Exponera ett API med scopet **`access_as_user`**; lägg till Office-värdarnas
      redirect-URI:er (se `DEPLOYMENT.md`).
- [ ] Sätt `AAD_CLIENT_ID` på hosten. Pinna gärna tenant med `AAD_TENANT=<tenant-GUID>`.
- [ ] **Postgres** (Neon/Supabase/Render): sätt `DATABASE_URL`. Lägg helst in
      providerns CA-bundle i `PGSSL_CA` för verifierad TLS. Tabeller skapas automatiskt.
- [ ] Bygg om manifestet med app-id:t inför Excel-steget:
      `npm run manifest:prod -- --base https://DITT_HOST --aad <AAD_CLIENT_ID>`

**Verifiera:** `https://DITT_HOST/api/health` → `"ssoConfigured":true` och
`"memoryStore":"postgres"`. I appen: **Inställningar → Minne → Logga in**.

---

## 3. Molnfiler + scheman (valfritt)

- [ ] **Molnfiler (☁ i chatten):** ge appen den **delegerade** Graph-behörigheten
      **`Files.Read`** (admin-medgivande) och skapa en **client secret**
      (`AAD_CLIENT_SECRET`). → `/api/health` visar `"graphConfigured":true`.
- [ ] **Schemalagd agent:** ge dessutom **applikations**-behörigheten
      **`Files.ReadWrite.All`** (admin-medgivande), sätt `AAD_TENANT` till en
      konkret GUID, och `SIMBA_SCHEDULER=1` på **EN** instans. → `/api/health`
      visar `"schedulerEnabled":true`. (Detaljer i `DEPLOYMENT.md`.)

---

## 4. Lansera webben + PWA (snabbast — börja här)

- [ ] Dela länken **`https://DITT_HOST/`** (serverar `index.html`, utan Office.js —
      startar direkt som fristående assistent).
- [ ] Valfritt: koppla en egen domän (t.ex. `simba.dittföretag.se`).
- [ ] PWA: i Edge/Chrome → **Installera app** → Simba får eget fönster och ikon.

**Verifiera:** sidan laddar, du kan chatta, och (om steg 2 är klart) logga in.

---

## 5. Rulla ut Excel-tillägget (den unika ytan)

Detta är enda ytan med **live-redigering av arket**.

- [ ] Säkerställ att `manifest.prod.xml` pekar på `https://DITT_HOST` (steg 2).
- [ ] Validera: `npm run validate` (mot rätt manifest).
- [ ] M365 admin center → **Inställningar → Integrerade appar → Ladda upp anpassad app**
      → ladda upp `manifest.prod.xml` → **tilldela** användare/grupp.
- [ ] Tillägget dyker upp i Excel under några timmar (Centralized Deployment).

**Verifiera:** öppna Excel → fliken **Start → Simba** → panelen laddar och kan
läsa/redigera arket.

---

## 6. Skrivbordsappen (valfritt — Intune)

Endast om någon specifikt vill ha en installerad .exe/.dmg. Annars täcker PWA:n
(steg 4) behovet utan kodsignering.

- [ ] Bygg signerad installer: `cd desktop && npm install && npm run dist`
      (Windows: code-signa; macOS: signera + notarisera).
- [ ] Ladda upp till **Intune** och tilldela (se `../desktop/README.md`).
- [ ] Auto-uppdatering: peka `build.publish` i `desktop/package.json` på din feed.

---

## 7. Slutkontroll före skarp drift

- [ ] `/api/health` visar förväntade `true`-flaggor.
- [ ] Webben laddar och svarar; en enkel fråga går snabbt (router → Haiku).
- [ ] Ett byggjobb i Excel funkar end-to-end (skapa en liten tabell + diagram),
      och rubriken finns kvar efter att Simba "fixat till".
- [ ] Inloggning fungerar och minne/chattar synkas mellan två enheter.
- [ ] (Om på) ett testschema körs och rapporterar resultat i **Inställningar → Scheman**.
- [ ] Rimliga gränser satta: `SIMBA_IP_RPM`, `SIMBA_SPEED`.

---

## 8. Kostnad & säkerhet

- API-nyckeln bills per användare. Modell-routern skickar enkla frågor till Haiku
  automatiskt; `SIMBA_SPEED=balanced` (standard) håller kostnaden nere — Snabbläge
  bills med premie.
- Hemligheter (`ANTHROPIC_API_KEY`, `AAD_CLIENT_SECRET`, `DATABASE_URL`) sätts bara
  som env på hosten, aldrig i repot.
- Per-IP-gräns och CORS-allowlist (`SIMBA_ALLOWED_ORIGINS`) skyddar mot missbruk.

## 9. Om något går fel

- **Excel: "fel vid inläsning"** → backend somnade (free-nivå) eller manifestet
  pekar fel. Kolla `/api/health` och manifestets `SourceLocation`.
- **Inloggning misslyckas** → `ssoConfigured:false`, fel redirect-URI, eller
  saknat `access_as_user`-scope.
- **Scheman kör inte** → `schedulerEnabled:false` (saknar `SIMBA_SCHEDULER=1`,
  app-only Graph, eller konkret `AAD_TENANT`).
- Rulla tillbaka genom att peka Render på föregående commit; manifest/host är
  oförändrade så Excel/PWA fortsätter fungera.
