const HOOK_URL = "http://127.0.0.1:18789/hooks/agent";

export async function notifyAgent(
  hookToken: string,
  message: string,
): Promise<boolean> {
  try {
    const resp = await fetch(HOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${hookToken}`,
      },
      body: JSON.stringify({
        message,
        name: "Claw2PR",
        wakeMode: "now",
        deliver: true,
        channel: "telegram",
        sessionKey: "main",
      }),
    });

    if (!resp.ok) {
      console.log(`[claw2pr] Hook notification failed: ${resp.status} ${resp.statusText}`);
      return false;
    }

    const data = (await resp.json()) as Record<string, unknown>;
    console.log(`[claw2pr] Hook notification sent, runId: ${data.runId}`);
    return true;
  } catch (e) {
    console.log(`[claw2pr] Hook notification error: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
