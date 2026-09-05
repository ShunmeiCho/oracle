import { describe, expect, it, vi } from "vitest";
import {
  classifyResponseModel,
  expectedResponseModel,
  verifyResponseModel,
} from "../../src/browser/responseModel.js";

const snapshot = {
  conversationId: "chat-1",
  messageId: "answer-1",
  text: "The verified answer",
  modelSlug: "gpt-6-pro",
};
describe("actual response model verification", () => {
  it("requires the Pro response identity independently of the picker", () => {
    expect(expectedResponseModel({ expectedModel: "gpt-6-astra", thinkingTime: "pro" })).toBe(
      "gpt-6-pro",
    );
    expect(
      classifyResponseModel("gpt-6-pro", snapshot, snapshot.text, "chat-1", "answer-1").status,
    ).toBe("verified");
  });
  it.each(["gpt-5.6-sol", "gpt-5.6-pro", "gpt-6-astra", "gpt-7-pro", "Latest", "Pro"])(
    "rejects %s for a GPT-6 Pro request",
    (modelSlug) => {
      expect(
        classifyResponseModel(
          "gpt-6-pro",
          { ...snapshot, modelSlug },
          snapshot.text,
          "chat-1",
          "answer-1",
        ).status,
      ).toBe("mismatch");
    },
  );
  it("does not borrow evidence from another answer or an unidentified conversation", () => {
    expect(
      classifyResponseModel("gpt-6-pro", snapshot, snapshot.text, "chat-1", "different-message")
        .status,
    ).toBe("unavailable");
    expect(
      classifyResponseModel(
        "gpt-6-pro",
        { ...snapshot, conversationId: null },
        snapshot.text,
        "chat-1",
        "answer-1",
      ).status,
    ).toBe("unavailable");
    expect(
      classifyResponseModel("gpt-6-pro", snapshot, snapshot.text, "other-chat", "answer-1").status,
    ).toBe("unavailable");
    expect(
      classifyResponseModel("gpt-6-pro", snapshot, "another answer", "chat-1", "answer-1").status,
    ).toBe("unavailable");
    expect(classifyResponseModel("gpt-6-pro", snapshot, snapshot.text).status).toBe("unavailable");
    expect(
      classifyResponseModel(
        "gpt-6-pro",
        { ...snapshot, modelSlug: null },
        snapshot.text,
        "chat-1",
        "answer-1",
      ).status,
    ).toBe("unavailable");
    expect(
      expectedResponseModel({ expectedModel: "gpt-6-astra", modelStrategy: "current" }),
    ).toBeUndefined();
  });
  it("fails a mismatched completed reply without resubmission", async () => {
    const evaluate = vi
      .fn()
      .mockResolvedValue({ result: { value: { ...snapshot, modelSlug: "gpt-5.6-sol" } } });
    await expect(
      verifyResponseModel(
        { evaluate } as never,
        { expectedModel: "gpt-6-astra", thinkingTime: "pro" },
        snapshot.text,
        vi.fn() as never,
        2,
        "chat-1",
        "answer-1",
      ),
    ).rejects.toThrow(/already submitted/);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0]?.[0].expression).toContain("chat-1");
  });
});
