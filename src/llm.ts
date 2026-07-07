import OpenAI from "openai";

// Lazy singleton so a warm Lambda reuses the client's connection pool.
let _groq: OpenAI | undefined;
const groq = () =>
  (_groq ??= new OpenAI({
    apiKey: process.env.GROQ_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
  }));

const LOCATIONS = [
  "a grocery store", "the moon", "a medieval castle", "a submarine", "a haunted mansion",
  "a desert island", "a busy office", "ancient Rome", "a circus tent", "a space station",
  "a laundromat", "the bottom of the ocean", "a ski lodge", "a jungle temple", "a diner at 3am",
];
const CHARACTERS = [
  "a grandma", "a robot", "three raccoons", "a wizard", "a toddler", "a pirate",
  "an alien tourist", "a mailman", "a giant hamster", "a knight", "a chef", "a ghost",
  "a cowboy", "a mermaid", "a very tired dentist",
];
const ACTIVITIES = [
  "having a dance battle", "eating spaghetti", "riding a unicycle", "arguing about taxes",
  "building a sandcastle", "juggling flaming torches", "taking a selfie", "walking a pet lobster",
  "doing yoga", "hosting a cooking show", "playing chess", "getting a haircut",
  "conducting an orchestra", "fixing a flat tire", "throwing a surprise party",
];

const pick = <T>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

/** Bot's round-0 move: invent a fun, drawable prompt. */
export async function botSeedPrompt(): Promise<string> {
  const seed = `${pick(CHARACTERS)} ${pick(ACTIVITIES)} in ${pick(LOCATIONS)}`;
  try {
    const res = await groq().chat.completions.create({
      model: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content:
            "You are playing a party game like Telestrations. Write one short, vivid, funny scene description that an AI image generator will draw. One sentence, under 15 words. No quotes, no preamble.",
        },
        { role: "user", content: `Riff on this idea (or improve it): ${seed}` },
      ],
      max_tokens: 60,
      temperature: 1.0,
    });
    const text = res.choices[0]?.message?.content?.trim();
    return text || seed;
  } catch (err) {
    console.error("botSeedPrompt failed, using raw seed", err);
    return seed;
  }
}

/** Bot's guessing move: describe what the upstream images depict. */
export async function botGuessFromImages(imageUrls: string[]): Promise<string> {
  const res = await groq().chat.completions.create({
    model: process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "These images were all generated from one hidden prompt in a party game. Guess the prompt: reply with a single short scene description (under 15 words), no quotes, no preamble.",
          },
          ...imageUrls.slice(0, 4).map((url) => ({
            type: "image_url" as const,
            image_url: { url },
          })),
        ],
      },
    ],
    max_tokens: 60,
    temperature: 0.8,
  });
  const text = res.choices[0]?.message?.content?.trim();
  if (!text) throw new Error("Empty vision response");
  return text;
}
