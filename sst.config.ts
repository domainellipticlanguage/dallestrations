/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app(input) {
    return {
      name: "dallestrations2",
      removal: input?.stage === "production" ? "retain" : "remove",
      home: "aws",
      providers: { aws: { region: "us-east-1" } },
    };
  },
  async run() {
    const table = new sst.aws.Dynamo("GameTable", {
      fields: { pk: "string", sk: "string", roomCode: "string" },
      primaryIndex: { hashKey: "pk", rangeKey: "sk" },
      globalIndexes: {
        // Sparse index: only active room META items carry roomCode.
        CodeIndex: { hashKey: "roomCode" },
      },
    });

    const bucket = new sst.aws.Bucket("GameImages", { access: "public" });

    const fn = new sst.aws.Function("Api", {
      handler: "handler.handler",
      runtime: "nodejs22.x",
      memory: "1024 MB",
      timeout: "120 seconds",
      architecture: "arm64",
      streaming: true,
      url: { authorization: "none", cors: true },
      link: [table, bucket],
      environment: {
        DYNAMODB_TABLE: table.name,
        S3_BUCKET: bucket.name,
        GROQ_API_KEY: process.env.GROQ_API_KEY ?? "",
        GROQ_MODEL: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
        GROQ_VISION_MODEL:
          process.env.GROQ_VISION_MODEL ?? "meta-llama/llama-4-scout-17b-16e-instruct",
        REPLICATE_API_TOKEN: process.env.REPLICATE_API_TOKEN ?? "",
        IMAGE_MODEL: process.env.IMAGE_MODEL ?? "black-forest-labs/flux-2-klein-4b",
        IMAGES_PER_PROMPT: process.env.IMAGES_PER_PROMPT ?? "2",
        ART_MEGAPIXELS: process.env.ART_MEGAPIXELS ?? "1",
      },
      copyFiles: [{ from: "frontend/dist", to: "frontend/dist" }],
    });

    const router = new sst.aws.Router("Router", {
      ...($app.stage === "production"
        ? {
            domain: {
              name: "dallestrations.com",
              redirects: ["www.dallestrations.com"],
              // Overwrite same-name records left from the previous hosting setup.
              dns: sst.aws.dns({ override: true }),
            },
          }
        : {}),
    });
    // "/" (not "/*"): SST Router path matching treats "/" as the catch-all.
    router.route("/", fn.url);

    return { url: router.url, lambdaUrl: fn.url };
  },
});
