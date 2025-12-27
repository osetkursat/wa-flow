import { getFlowState, setFlowState, clearFlowState } from "./db.js";

function looksLikeOrderIntent(text = "") {
  const t = text.toLowerCase();
  const hasKeyword = ["sipariş", "kargo", "nerede", "takip", "teslim"].some(k => t.includes(k));
  const hasOrderNo = /\d{5,}/.test(t);
  return hasKeyword || hasOrderNo;
}

function extractOrderNo(text = "") {
  const m = text.match(/\d{5,}/);
  return m ? m[0] : null;
}

export async function handleIncomingText({ customerId, text }) {
  const state = await getFlowState(customerId);

  if (!state) {
    if (!looksLikeOrderIntent(text)) {
      return {
        reply:
`Merhaba 👋
1) Sipariş Takibi
2) Ürün & Teknik Soru
3) İade / Değişim

“Siparişim nerede” yaz veya “1” yaz.`,
        next: null
      };
    }

    const orderNo = extractOrderNo(text);
    if (orderNo) {
      await clearFlowState(customerId);
      return {
        reply:
`Sipariş no: ${orderNo}
Kontrol ediyorum ✅

(MVP) Bir sonraki adım: IdeaSoft’tan durum + kargo takip linkini otomatik çekip yazacağım.`,
        next: null
      };
    }

    await setFlowState(customerId, "order_tracking", "ASK_ORDER_NO", {});
    return { reply: "Sipariş takibi için sipariş numaranı yazar mısın? (Örn: 123456)", next: null };
  }

  if (state.flow_name === "order_tracking" && state.step === "ASK_ORDER_NO") {
    const orderNo = extractOrderNo(text);
    if (!orderNo) return { reply: "Sipariş numarasını rakamlarla yazar mısın? (Örn: 123456)", next: null };

    await clearFlowState(customerId);
    return {
      reply:
`Sipariş no: ${orderNo}
Kontrol ettim ✅

(MVP) Sıradaki adım: IdeaSoft entegrasyonu ile gerçek sipariş/kargo bilgisi dönecek.`,
      next: null
    };
  }

  await clearFlowState(customerId);
  return { reply: "Bir hata oldu, baştan başlayalım. “1” yazabilirsin.", next: null };
}
