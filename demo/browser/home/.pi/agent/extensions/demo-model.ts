// A scripted model, so the demo runs real pi without an API key and nothing leaves the browser.
// Each prompt below has a fixed run of replies; the tools they call (read, edit, bash) are real.
// pi-git asks the same model for commit messages, so those requests get a scripted message for the staged change.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  calculateCost,
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";

const model = {
  id: "scripted",
  name: "Scripted",
  reasoning: true,
  input: ["text" as const],
  // Priced like a mid-size hosted model, so pi-git's commit notice shows what the message would cost.
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 32_000,
};

const oldLine = 'console.log(`${city}: ${reading.sky}, ${reading.low}-${reading.high}°C, ${Math.round(reading.rain * 100)}% chance of rain`);';
const newLines = `if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ city, ...reading }));
} else {
  ${oldLine}
}`;
const oslo = '  oslo: { sky: "light rain", high: 9, low: 4, rain: 0.8 },';
const newYork = `${oslo}\n  "new york": { sky: "partly cloudy", high: 18, low: 11, rain: 0.2 },`;

type Step = ReturnType<typeof fauxAssistantMessage>;
const toolUse = { stopReason: "toolUse" as const };

// Matched against the latest prompt; each entry lists the replies in order, one per model request.
const scripts: { match: RegExp; steps: Step[] }[] = [
  {
    match: /json/i,
    steps: [
      fauxAssistantMessage([fauxThinking("A flag check around the final print is enough; keep the text output as it is."), fauxToolCall("edit", { path: "src/cli.js", edits: [{ oldText: oldLine, newText: newLines }] })], toolUse),
      fauxAssistantMessage([fauxToolCall("bash", { command: "node src/cli.js Lisbon --json && node src/cli.js Lisbon" })], toolUse),
      fauxAssistantMessage([fauxText("Added `--json`: it prints the reading as one JSON object, and the plain output is unchanged. Commit it with **/git-quick-commit**, or stage it yourself in **/git**.")]),
    ],
  },
  {
    match: /new york/i,
    steps: [
      fauxAssistantMessage([fauxToolCall("edit", { path: "src/readings.js", edits: [{ oldText: oslo, newText: newYork }] })], toolUse),
      fauxAssistantMessage([fauxToolCall("bash", { command: 'node src/cli.js "New York"' })], toolUse),
      fauxAssistantMessage([fauxText("New York has a reading now.")]),
    ],
  },
];

// Commit messages for the staged patch pi-git sends, by what the patch contains.
const commitMessages: { match: RegExp; message: string }[] = [
  { match: /--json[\s\S]*new york|new york[\s\S]*--json/i, message: "feat(cli): add a --json flag and a New York reading\n\n--json prints the reading as one JSON object; the plain output is unchanged." },
  { match: /--json/, message: "feat(cli): add a --json flag for machine-readable output\n\nPrints the reading as one JSON object, so scripts can use it. The plain\noutput is unchanged." },
  { match: /new york/i, message: "feat(readings): add New York to the sample" },
];

const fallback = fauxAssistantMessage([
  fauxText("I'm a scripted stand-in for a model, so I only know a few prompts. Try **add a --json flag**, then commit it with **/git-quick-commit** or stage it in **/git**."),
]);

function text(content: unknown): string {
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part?.text ?? "").join(" ") : "";
}

function nextStep(context: { messages: { role: string; content: unknown }[] }): Step {
  const lastUser = context.messages.findLastIndex((message) => message.role === "user");
  const prompt = text(context.messages[lastUser]?.content);
  const replies = context.messages.slice(lastUser + 1).filter((message) => message.role === "assistant").length;
  const script = scripts.find((candidate) => candidate.match.test(prompt));
  return script?.steps[replies] ?? (replies === 0 ? fallback : fauxAssistantMessage([fauxText("Done.")]));
}

function commitReply(context: { messages: { content: unknown }[] }): Step {
  const evidence = text(context.messages.at(-1)?.content);
  const known = commitMessages.find((candidate) => candidate.match.test(evidence));
  return fauxAssistantMessage([fauxText(known?.message ?? "chore: update the forecast CLI")]);
}

const isCommitRequest = (context: { systemPrompt?: string }) => context.systemPrompt?.startsWith("You write one Git commit message") ?? false;

export default function demoModel(pi: ExtensionAPI): void {
  const agent = createFauxCore({ provider: "demo", api: "demo-scripted", models: [model], tokensPerSecond: 90 });
  // A second core for commit messages, which a quick commit generates while the agent may still be working.
  const writer = createFauxCore({ provider: "demo", api: "demo-scripted", models: [model], tokensPerSecond: 60 });
  pi.registerProvider("demo", {
    name: "Demo",
    baseUrl: "http://demo.invalid",
    apiKey: "demo",
    api: "demo-scripted" as never,
    models: [model],
    streamSimple: (requestModel, context, options) => {
      const core = isCommitRequest(context) ? writer : agent;
      core.setResponses([isCommitRequest(context) ? commitReply(context as never) : nextStep(context as never)]);
      const source = core.streamSimple(requestModel as never, context, options);
      // The faux provider counts tokens but leaves cost at zero; price them like a real reply.
      const priced = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of source) {
          if (event.type === "done") event.message.usage.cost = calculateCost(requestModel, event.message.usage);
          priced.push(event);
        }
        priced.end();
      })();
      return priced;
    },
  });
}
