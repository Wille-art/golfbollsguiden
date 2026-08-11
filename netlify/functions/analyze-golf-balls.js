import Anthropic from "@anthropic-ai/sdk";

// API-nyckeln läses från miljövariabeln ANTHROPIC_API_KEY, som du sätter i
// Netlify-dashboarden (Site configuration → Environment variables). Den ska
// aldrig ligga i den här filen eller i repot.
const anthropic = new Anthropic();

const MODEL = "claude-opus-5";

// Netlifys synkrona funktioner har en payload-gräns runt 6 MB. Vi stoppar
// större bilder här istället för att låta Netlify svara med ett 413 som
// frontend inte kan tolka. Klienten skalar redan ner bilden före uppladdning.
const MAX_IMAGE_BYTES = 4_500_000;

const ALLOWED_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Strukturerad output — modellen tvingas returnera exakt den här formen, så
// frontend kan JSON.parse:a svaret utan att gissa.
const SCAN_SCHEMA = {
  type: "object",
  properties: {
    identified: {
      type: "array",
      description:
        "Bollar som säkert kan läsas ut ur bilden. Tom array om ingen kan identifieras.",
      items: {
        type: "object",
        properties: {
          brand: {
            type: "string",
            description: "Tillverkare, exakt som den skrivs i katalogen, t.ex. 'Titleist'.",
          },
          name: {
            type: "string",
            description: "Modellnamn, exakt som det skrivs i katalogen, t.ex. 'Pro V1'.",
          },
          confidence: {
            type: "string",
            enum: ["hög", "medel", "låg"],
            description: "Hur säker läsningen av modellnamnet är.",
          },
        },
        required: ["brand", "name", "confidence"],
        additionalProperties: false,
      },
    },
    note: {
      type: "string",
      description:
        "En kort mening på svenska om vad som syns i bilden, eller varför inget kunde identifieras.",
    },
  },
  required: ["identified", "note"],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `Du identifierar golfbollar i foton för en svensk jämförelsesajt.

Du får en bild och en katalog med de bollar sajten känner till. Läs av bilden och
returnera bara bollar vars modellnamn du faktiskt kan läsa eller känna igen, och
som finns i katalogen. Använd katalogens exakta stavning av tillverkare och modell.

Hitta aldrig på en boll. Om texten är oläslig, bilden suddig, eller bollen inte
finns i katalogen: lämna "identified" tom och förklara kort i "note" vad som
saknades. En tom lista är ett korrekt svar — en gissning är det inte.

Skriv "note" på svenska.`;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

// Server-side fallback: om Anthropics säkerhetsklassificerare skulle avvisa en
// begäran körs den om på en annan modell i samma anrop. Skulle betaflaggan inte
// vara aktiverad på kontot faller vi tillbaka på ett vanligt anrop istället för
// att låta hela funktionen dö på ett 400.
async function createMessage(params) {
  try {
    return await anthropic.beta.messages.create({
      ...params,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  } catch (err) {
    const message = String(err?.message ?? "");
    const isBetaProblem =
      err?.status === 400 && /fallback|beta/i.test(message);
    if (!isBetaProblem) throw err;
    return await anthropic.messages.create(params);
  }
}

export default async function handler(req) {
  if (req.method !== "POST") {
    return json({ error: "Endast POST." }, 405);
  }

  // Mjuk origin-kontroll: blockerar att andra sajter anropar endpointen från en
  // webbläsare och bränner din API-budget. Anrop utan Origin-header (curl,
  // server-till-server) släpps igenom — se noteringen om rate limiting nedan.
  const origin = req.headers.get("origin");
  if (origin) {
    const allowed = new Set(
      [new URL(req.url).host, process.env.ALLOWED_ORIGIN_HOST].filter(Boolean),
    );
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch {
      return json({ error: "Ogiltig origin." }, 403);
    }
    if (!allowed.has(originHost)) {
      return json({ error: "Otillåten origin." }, 403);
    }
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Kunde inte läsa JSON-kroppen." }, 400);
  }

  const { imageBase64, mediaType, catalogNames } = payload ?? {};

  if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
    return json({ error: "imageBase64 saknas." }, 400);
  }
  if (!ALLOWED_MEDIA_TYPES.has(mediaType)) {
    return json(
      { error: `Bildformatet stöds inte: ${mediaType ?? "okänt"}.` },
      400,
    );
  }
  // base64 är ~4/3 av råstorleken
  if (imageBase64.length * 0.75 > MAX_IMAGE_BYTES) {
    return json({ error: "Bilden är för stor. Ta en ny bild med lägre upplösning." }, 413);
  }
  if (typeof catalogNames !== "string" || catalogNames.length === 0) {
    return json({ error: "catalogNames saknas." }, 400);
  }

  try {
    const response = await createMessage({
      model: MODEL,
      max_tokens: 8000,
      // Låg effort håller svarstiden nere — funktionen har en hård timeout hos
      // Netlify. Höj till "medium" om identifieringen blir för slarvig.
      output_config: {
        effort: "low",
        format: { type: "json_schema", schema: SCAN_SCHEMA },
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: imageBase64 },
            },
            {
              type: "text",
              text: `Katalogen sajten känner till:\n${catalogNames}\n\nVilka av dessa bollar syns i bilden?`,
            },
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      console.warn("Modellen avvisade begäran:", response.stop_details);
      return json({ error: "Bilden kunde inte analyseras." }, 422);
    }
    if (response.stop_reason === "max_tokens") {
      return json({ error: "Svaret blev avbrutet. Försök igen." }, 502);
    }

    // Skicka bara tillbaka textblocken — frontend förväntar sig content[].text.
    return json({ content: response.content.filter((b) => b.type === "text") });
  } catch (err) {
    console.error("Anthropic-anropet misslyckades:", err);
    const status = err?.status === 429 ? 429 : 502;
    return json(
      {
        error:
          status === 429
            ? "För många förfrågningar just nu. Försök igen om en stund."
            : "AI-tjänsten svarade inte.",
      },
      status,
    );
  }
}
