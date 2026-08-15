// src/lib/agent-hook.ts
// Hook de integración con el Agente de Pedidos IA (glowylamps)
// Se ejecuta en el webhook de WhatsApp (route.ts) después de flows/automations/AI auto-reply
// y delega el turno de conversación al agente que corre en glowylamps vía POST /api/agent/turn.

import crypto from "node:crypto";
import { sendMessageToConversation } from "@/lib/whatsapp/send-message";
import { supabaseAdmin } from "@/lib/automations/admin-client";

interface AgentHookInput {
  conversation: { id: string };
  contact: { id: string };
  text: string;
  media_url: string | null;
  media_type: string | null;
  accountId: string;
  configOwnerUserId: string;
}

/**
 * Hook del Agente de Pedidos IA
 *
 * El agente completo (Claude + 7 tools + session-store + BD) corre server-side en glowylamps.
 * wacrm solo relaya: mensaje entrante → glowylamps → respuesta → cliente.
 *
 * ACTIVACIÓN: setear AGENT_ENABLED="true" en variables de entorno de wacrm.
 * Por defecto está desactivado (no-op) para no romper flujo existente.
 */
export async function afterAgentHook({
  conversation,
  contact,
  text,
  media_url,
  media_type,
  accountId,
  configOwnerUserId,
}: AgentHookInput): Promise<void> {
  // Feature flag — no-op si no está activado
  if (process.env.AGENT_ENABLED !== "true") {
    return;
  }

  // Validar variables requeridas
  const glowylampsApiUrl = process.env.GLOWYLAMPS_API_URL;
  const webhookSecret = process.env.WACRM_WEBHOOK_SECRET;

  if (!glowylampsApiUrl || !webhookSecret) {
    console.warn("[agent] Missing GLOWYLAMPS_API_URL or WACRM_WEBHOOK_SECRET, skipping agent turn");
    return;
  }

  try {
    // Armar payload para glowylamps
    const body = {
      contact_id: contact.id,
      wa_conversation_id: conversation.id,
      text: text || "",
      media_url: media_url || null,
      media_type: media_type || null,
    };

    const bodyStr = JSON.stringify(body);
    const t = Math.floor(Date.now() / 1000);
    const v1 = crypto
      .createHmac("sha256", webhookSecret)
      .update(`${t}.${bodyStr}`)
      .digest("hex");
    const signature = `t=${t},v1=${v1}`;

    // POST a glowylamps /api/agent/turn (timeout 30s)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    const res = await fetch(`${glowylampsApiUrl}/api/agent/turn`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-wacrm-signature": signature,
      },
      body: bodyStr,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (res.ok) {
      const { reply, session_status, done, handoff } = await res.json();

      if (reply) {
        // wacrm envía el reply al cliente usando sendMessageToConversation
        await sendMessageToConversation(supabaseAdmin(), accountId, {
          conversationId: conversation.id,
          messageType: "text",
          contentText: reply,
        });
      }

      // Si handoff=true, el agente ya llamó assign_conversation + tags en glowylamps
      // wacrm solo deja que la conversación fluya (equipo humano toma control)
      if (handoff) {
        console.log("[agent] Handoff completed, human team will take over");
      }
    } else {
      console.error("[agent] glowylamps error:", res.status, await res.text());
      // Fallback: no romper, dejar seguir a flows/automations existentes
    }
  } catch (e) {
    console.error("[agent] network error:", e);
    // Fallback silencioso - no cortar la conversación
  }
}