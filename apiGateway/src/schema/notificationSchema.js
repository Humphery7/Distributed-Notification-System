export const notificationPayloadSchema = {
    type: "object",
    required: ["notification_type", "user_id", "template_code", "variables", "request_id"],
    properties: {
      notification_type: { type: "string", enum: ["email", "push"] },
      user_id: { type: "string", format: "uuid" },
      template_code: { type: "string" },
      variables: { type: "object" },
      request_id: { type: "string" },
      priority: { type: "integer", minimum: 0, default: 0 },
      metadata: { type: "object", nullable: true }
    }
  };
  