export const userPayloadSchema = {
    type: "object",
    required: ["name", "email", "preferences", "password"],
    properties: {
      name: { type: "string", minLength: 1 },
      email: { type: "string", format: "email" },
      push_token: { type: "string", nullable: true },
      preferences: {
        type: "object",
        required: ["email", "push"],
        properties: {
          email: { type: "boolean" },
          push: { type: "boolean" }
        }
      },
      password: { type: "string", minLength: 8 }
    }
  };
  