# Orderskanner mot Google Sheets

En liten webbapp (PWA) som läser av ett spårningsnummer (t.ex. streckkoden på
en fraktetikett) med mobilkameran eller en handdator, hittar vilken order
koden hör till i ett Google Sheet, och ställer samman alla artikelrader som
ingår i den ordern (artikel + antal). Varje skanning loggas tillbaka till
arket. Inget konto, ingen backend, ingen databas — allt körs i webbläsaren
och pratar direkt med Google Sheets API.

Filerna i den här mappen:

```
index.html      – appens gränssnitt
style.css       – utseende
app.js          – all logik (inloggning, kamera, Sheets-anrop)
manifest.json   – gör appen installerbar på hemskärmen
sw.js           – service worker (cache för snabb start/offline-skal)
icons/          – app-ikoner
```

Du behöver göra tre saker innan appen fungerar:

1. **Förbereda ditt Google Sheet**
2. **Skapa en OAuth-klient i Google Cloud** (så appen får lov att läsa/skriva i ditt ark)
3. **Lägga filerna på en HTTPS-webbadress** (kameran och Google-inloggning kräver HTTPS)

---

## 1. Förbered Google Sheet

Appen förväntar sig ett Google Sheet där **varje rad är en artikelrad i en
order** – dvs. samma ordernummer kan förekomma på flera rader, en per
artikel i den ordern. Det här är det vanliga formatet på exporter från
order-/lagersystem, t.ex:

| A | B (Order) | C | D | E | F | G (Art.nr) | H (Namn) | I (Var.) | J (Antal) | … | AB (Spårning) |
|---|-----------|---|---|---|---|------------|----------|----------|-----------|---|----------------|
| 1 | 4711      |   |   |   |   | ART1       | Röd      | M        | 2         |   | `=HYPERLINK("https://www.postnord.se/...";"24544947934SE")` |
| 2 | 4711      |   |   |   |   | ART2       | Blå      | L        | 1         |   |                |
| 3 | 4712      |   |   |   |   | ART9       | Grön     | S        | 4         |   | `=HYPERLINK("...";"70112233445566")` |

Standardinställningarna i appen matchar layouten ovan rakt av:

| Vad                                   | Standardkolumn | Var i tabellen ovan |
|----------------------------------------|:--------------:|----------------------|
| Ordernummer                            | **B**           | kolumn 2 |
| Spårningsnummer (det som skannas)      | **AB**          | kolumn 28, HYPERLINK-cellens *synliga text* |
| Artikel (slås ihop med "-")            | **G, H, I**     | kolumn 7–9 |
| Antal                                  | **J**           | kolumn 10 |

Stämmer inte dina kolumner exakt med det här (t.ex. om ordernumret ligger i
en annan kolumn, eller om det bara är 2 artikelkolumner) ändrar du det under
Inställningar (⚙) i appen – se avsnitt 4. Kolumner anges som bokstäver
precis som i kalkylarket (A, B, … Z, AA, AB …), inte som siffror.

Viktigt att veta:

- **Spårningsnumret får gärna vara en `HYPERLINK`-formel** (som i exemplet).
  Appen läser cellens *visade värde*, vilket för en sådan formel är exakt
  länktexten (t.ex. `24544947934SE`) – inte URL:en och inte formeltexten.
  Det är alltså precis det du skulle se om du tittade på cellen, och det som
  vanligtvis är samma sträng som streckkoden på fraktetiketten.
- Spårningsnumret behöver bara finnas på **en** av ordens rader – appen
  hittar ordernumret från den raden och hämtar sen alla rader med samma
  ordernummer, oavsett om de har ett spårningsnummer ifyllt eller inte.
- Om samma artikelkombination (kolumn 7-9 hopslaget) förekommer på flera
  rader inom samma order **summeras antalet** automatiskt – du behöver
  alltså inte förhandsaggregera raderna själv.
- Rad 1 antas vara rubrikrad och hoppas alltid över (data börjar läsas från
  rad 2). Går det att ändra under Inställningar om ditt ark saknar
  rubrikrad eller har fler.
- Du behöver **inte** skapa loggfliken själv – appen skapar automatiskt en
  flik (standardnamn **"Skanningar"**) med kolumnerna Tidpunkt,
  Spårningsnummer, Ordernummer, Antal artikelrader, Status, och lägger till
  en rad varje gång något skannas.
- Kopiera **Sheet-ID** från adressfältet, den långa koden mellan `/d/` och
  `/edit`:
  `https://docs.google.com/spreadsheets/d/`**`DEN_HÄR_KODEN`**`/edit`

---

## 2. Skapa OAuth-klient i Google Cloud

Appen loggar in med ditt eget Google-konto (samma konto som äger eller har
redigeringsåtkomst till arket) och pratar direkt med Google Sheets API – helt
utan egen server eller hemliga nycklar.

1. Gå till [Google Cloud Console](https://console.cloud.google.com/) och
   skapa ett nytt projekt (eller använd ett befintligt).
2. Sök upp **"Google Sheets API"** under *APIs & Services → Library* och
   klicka **Enable**.
3. Gå till *APIs & Services → OAuth consent screen*.
   - Välj **External** (om du inte har Google Workspace) och fyll i
     appnamn + din e-post.
   - Under **Test users**, lägg till ditt eget Google-konto (och ev. andras
     konton som ska få använda appen). Så länge appen är i "Testing"-läge
     är det bara dessa konton som kan logga in – det är precis vad vi vill
     för ett privat verktyg.
4. Gå till *APIs & Services → Credentials → Create Credentials → OAuth
   client ID*.
   - Application type: **Web application**.
   - Under **Authorized JavaScript origins**, lägg till adressen där du ska
     lägga appen, t.ex.:
     - `https://ditt-användarnamn.github.io` (GitHub Pages)
     - `http://localhost:5500` (om du vill testa lokalt först)
   - Du behöver **inte** ange någon "Authorized redirect URI" – appen
     använder ett token-flöde utan omdirigering.
   - Klicka **Create** och kopiera **klient-ID:t** (slutar på
     `.apps.googleusercontent.com`).

Klient-ID:t klistrar du sen in i appens Inställningar (kugghjulet) –
du behöver aldrig redigera någon kod.

> Notera: Om du senare vill lägga appen på en annan adress måste du lägga
> till den adressen under "Authorized JavaScript origins" också.

---

## 3. Lägg filerna på HTTPS

Kameran (`getUserMedia`) och Google-inloggningen kräver att sidan laddas via
**HTTPS** (eller `http://localhost` när du testar lokalt) – det går alltså
inte att bara dubbelklicka på `index.html`.

### Enklast: GitHub Pages (gratis)

1. Skapa ett nytt repo på GitHub, t.ex. `ean-skanner`.
2. Ladda upp alla filer i den här mappen (`index.html`, `style.css`,
   `app.js`, `manifest.json`, `sw.js`, `icons/`) till repots rot.
3. Gå till repots **Settings → Pages**, välj **Deploy from branch**, branch
   `main`, mapp `/root`, spara.
4. Efter någon minut är appen live på
   `https://ditt-användarnamn.github.io/ean-skanner/`.
5. Lägg till exakt den adressen (utan avslutande sökväg, bara
   `https://ditt-användarnamn.github.io`) under Authorized JavaScript
   origins i steg 2 om du inte redan gjort det.

### Alternativ: Netlify eller Vercel

Dra och släpp mappen på [Netlify Drop](https://app.netlify.com/drop) eller
koppla repot till [Vercel](https://vercel.com/) – båda ger dig en gratis
HTTPS-adress på några sekunder. Kom ihåg att lägga till den adressen som
JavaScript origin i Google Cloud, precis som ovan.

### Testa lokalt först (valfritt)

```bash
cd ean-scanner-app
python3 -m http.server 5500
```

Öppna sen `http://localhost:5500` i mobilens eller datorns webbläsare (lägg
till `http://localhost:5500` som JavaScript origin). Fungerar bäst på dator
för att testa flödet – för kameratest på riktig mobil krävs HTTPS, så då är
det dags att deploya enligt ovan.

---

## 4. Använd appen

1. Öppna adressen på mobilen. På iPhone (Safari) eller Android (Chrome) kan
   du trycka **"Lägg till på hemskärmen"** för att installera den som en
   vanlig app.
2. Tryck kugghjulet ⚙ och fyll i:
   - **Google OAuth-klient-ID** (från steg 2)
   - **Google Sheet-ID** (från steg 1)
   - Flikarna för orderrader/logg (standard: "Produkter" / "Skanningar")
   - Kolumnerna för Ordernummer, Spårningsnummer, Artikel och Antal, om de
     inte redan matchar standardvärdena (B / AB / G,H,I / J) – se avsnitt 1.
3. Tryck **Logga in med Google** och godkänn åtkomsten.
4. Högst upp väljer du inmatningskälla:
   - **📷 Kamera** – tryck **Starta kamera** och rikta mot spårningskoden.
   - **🔫 Extern skanner** – för handdatorer med inbyggd skanner (se avsnitt 5
     nedan om du kör på en Cipherlab).
   Träff visar ordernumret och en lista på ordens artiklar (artikel + antal),
   och skanningen loggas i arket. Läser skannern fel, eller vill du testa
   en kod manuellt? Använd **"Ange spårningsnummer manuellt"** längst ner
   istället.

---

## 5. Cipherlab (eller annan handdator med inbyggd skanner)

De flesta Cipherlab-handdatorer (t.ex. RS35, CP30, RK25, OK5000) kör Android
och har en inbyggd laser-/2D-imager-skanner som är mycket snabbare och
säkrare att använda än att läsa av kameran med JavaScript. Appen har därför
ett eget **"🔫 Extern skanner"-läge** byggt för det.

### Så fungerar det

Cipherlabs skanner konfigureras normalt som **Keyboard Wedge** (även kallat
"Keyboard Emulation"): en tryckning på avtryckaren matar in den skannade
koden som om den skrivits på ett tangentbord, följt av Enter. I
"Extern skanner"-läget håller appen ett textfält ständigt fokuserat och
läser automatiskt av koden så fort Enter kommer – ingen knapptryckning i
appen behövs, och fältet återfokuseras automatiskt om det skulle tappa
fokus.

### Konfigurera skannern på Cipherlab-enheten

1. Öppna den förinstallerade inställningsappen för skannern (heter oftast
   **ScanSettings**, **ReaderConfig** eller **Barcode Utility** beroende på
   modell och Android-version).
2. Gå till **Output Method** (eller **Wedge Method**) och välj
   **Keyboard Emulation** / **Keyboard Wedge**.
3. Under formatering, sätt **Suffix** till **Enter (CR)** – det är det som
   talar om för appen att koden är klar. Lämna Prefix tomt.
4. Spara. Testa gärna i en vanlig anteckningsapp först: en skanning ska ge
   dig koden som text, följt av ett radbyte.

### I appen

1. Installera appen på hemskärmen (öppna adressen i Chrome → meny →
   "Lägg till på startskärmen").
2. Öppna appen, logga in, och välj **🔫 Extern skanner**-fliken. Vill du att
   appen alltid ska öppnas i det läget på just den här enheten, sätt
   **Standardläge vid start** till "Extern skanner" i Inställningar
   (⚙) – appen kommer också ihåg det senaste läget du använde automatiskt.
3. Tryck på avtryckaren. Koden matas in, slås upp mot arket och loggas –
   fältet töms och är redo för nästa skanning direkt.

### Om det skjuter upp ett tangentbord på skärmen

Fältet är byggt för att inte trigga det virtuella tangentbordet
(`inputmode="none"`), men vissa tillverkares egna tangentbord ignorerar det.
Om det ändå dyker upp, testa något av:

- Stäng av **"Visa alltid virtuellt tangentbord"** under Android →
  Inställningar → System → Språk och inmatning.
- Använd Cipherlabs egen konfigurationsapp för att låsa/dölja
  skärmtangentbordet i kiosk-/launcher-läge, om enheten är MDM-hanterad.

---

## Vanliga problem

- **"Access blocked: this app's request is invalid" / origin mismatch** –
  adressen du öppnar appen från matchar inte exakt vad du lagt in under
  Authorized JavaScript origins i Google Cloud (inklusive `https://` och utan
  avslutande `/`).
- **"Access blocked: app has not completed verification"** – lägg till ditt
  Google-konto som testanvändare under OAuth consent screen (steg 2.3). Så
  länge det bara är du/ditt team som använder appen behöver ni inte skicka
  in appen för Googles verifieringsprocess.
- **Kameran startar inte** – kontrollera att sidan laddas via `https://`
  (eller `localhost`), och att du gett webbläsaren kameratillstånd.
- **"Ogiltig kolumninställning"** – någon av kolumnbokstäverna i
  Inställningar är tom eller felstavad. De ska anges som bokstäver (t.ex.
  `AB`), inte siffror.
- **Ordern hittas men artikellistan är tom** – kontrollera att
  artikelkolumnerna (standard G,H,I) faktiskt innehåller text på de
  raderna, och att de pekar på rätt kolumner för ditt ark.
- **Skanningen i "Extern skanner"-läge gör ingenting** – kontrollera att
  skannern är satt till Keyboard Emulation/Wedge med Suffix = Enter (se
  avsnitt 5). Testa i en anteckningsapp för att se att en skanning verkligen
  ger text + radbyte, oberoende av vår app.
- **Ändringar i arket syns inte** – appen cachar orderlistan i 5 minuter per
  session för att inte göra ett API-anrop per skanning. Ladda om sidan för
  att tvinga fram en ny hämtning direkt.

## Om säkerhet

Appen lagrar bara inställningarna (klient-ID, Sheet-ID, fliknamn) i
webbläsarens `localStorage` på din egen enhet – inget skickas till någon
server förutom Googles egna API:er. Åtkomsttoken hämtas via Googles
standardflöde för inloggning i webbläsaren och ger appen enbart rättighet
att läsa/skriva i Google Sheets (scope `spreadsheets`) för det konto som
loggar in – inget lösenord eller nyckel lagras någonstans i koden.
