const express = require("express");
const bcrypt = require("bcrypt");

const app = express();
app.use(express.json());

app.post("/naver-token", async (req, res) => {
  try {
    const { client_id, client_secret } = req.body;

    if (!client_id || !client_secret) {
      return res.status(400).json({
        error: "client_id / client_secret 필요"
      });
    }

    const timestamp = Date.now();
    const password = `${client_id}_${timestamp}`;
    const hashed = bcrypt.hashSync(password, client_secret);
    const client_secret_sign = Buffer.from(hashed, "utf-8").toString("base64");

    const body = new URLSearchParams({
      client_id,
      timestamp: String(timestamp),
      client_secret_sign,
      grant_type: "client_credentials",
      type: "SELF"
    });

    const tokenRes = await fetch("https://api.commerce.naver.com/external/v1/oauth2/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const text = await tokenRes.text();

    res.status(tokenRes.status).type("application/json").send(text);
  } catch (e) {
    res.status(500).json({
      error: "token 요청 실패",
      detail: String(e)
    });
  }
});

// [결제누락/IP마지막기회 완벽대비] 데이일 4대장 집계 엔진
// [최종 수정본] 데이일 4대장 집계 엔진
app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;

    if (!access_token || !target_date) {
      return res.status(400).json({ error: 'access_token / target_date 필요' });
    }

    const authHeaders = {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    };

    // 1) 변경 주문 전체 페이지 수집
    const changedStatuses = await fetchAllChangedStatuses_(access_token, target_date);

    if (changedStatuses.length === 0) {
      return res.json({
        date: target_date,
        pay: 0,
        cancel: 0,
        return: 0,
        refund: 0
      });
    }

    // 2) 상세 조회용 전체 ID / 결제금액용 ID 분리
    const latestById = new Map(); // productOrderId -> status
    const payIds = new Set();

    for (const s of changedStatuses) {
      const id = s.productOrderId;
      if (!id) continue;

      latestById.set(id, s);

      // 결제일이 target_date면 결제금액 집계 대상으로 넣음
      // paymentDate는 변경 상품 주문 구조체에 포함됨
      if (s.paymentDate && String(s.paymentDate).startsWith(target_date)) {
        payIds.add(id);
      }
    }

    const allIds = [...latestById.keys()];
    const detailMap = await fetchProductOrderDetailsMap_(authHeaders, allIds);

    let totalPay = 0;
    let totalCancel = 0;
    let totalReturn = 0;
    let totalRefund = 0;

    // 3) 결제금액 계산
    for (const id of payIds) {
      const detail = detailMap.get(id);
      if (!detail) continue;

      const po = detail.productOrder || {};
      const ord = detail.order || {};

      // 우선순위: 상품주문 결제금액 -> 주문 결제금액 파생값
      const amt =
        toSafeNumber_(po.totalPaymentAmount) ||
        toSafeNumber_(po.totalAmount) ||
        toSafeNumber_(ord.generalPaymentAmount) +
          toSafeNumber_(ord.chargeAmountPaymentAmount) +
          toSafeNumber_(ord.checkoutAccumulationPaymentAmount) +
          toSafeNumber_(ord.naverMileagePaymentAmount) +
          toSafeNumber_(ord.payLaterPaymentAmount);

      totalPay += amt;
    }

    // 4) 취소 / 반품 / 환불 계산
    for (const [id, s] of latestById.entries()) {
      const detail = detailMap.get(id);
      if (!detail) continue;

      const po = detail.productOrder || {};
      const amt = toSafeNumber_(po.totalPaymentAmount) || toSafeNumber_(po.totalAmount);

      // 클레임 완료건만 취소/반품/환불로 집계
      if (s.lastChangedType === 'CLAIM_COMPLETED') {
        const claimType = po.claimType || s.claimType || '';
        const claimStatus = po.claimStatus || s.claimStatus || '';
        const poStatus = po.productOrderStatus || s.productOrderStatus || '';

        const isCancel =
          poStatus === 'CANCELED' ||
          claimType === 'CANCEL' ||
          claimType === 'ADMIN_CANCEL' ||
          claimStatus === 'CANCEL_DONE' ||
          claimStatus === 'ADMIN_CANCEL_DONE';

        const isReturn =
          poStatus === 'RETURNED' ||
          claimType === 'RETURN' ||
          claimStatus === 'RETURN_DONE';

        if (isCancel) totalCancel += amt;
        if (isReturn) totalReturn += amt;

        // 환불금액 우선순위
        let exactRefund = 0;

        if (Array.isArray(detail.completedClaims) && detail.completedClaims.length > 0) {
          for (const c of detail.completedClaims) {
            exactRefund +=
              toSafeNumber_(c.refundAmount) ||
              toSafeNumber_(c.totalRefundAmount) ||
              0;
          }
        }

        if (!exactRefund && detail.claim && detail.claim.refundInfo) {
          exactRefund += toSafeNumber_(detail.claim.refundInfo.refundAmount);
        }

        if (!exactRefund && detail.currentClaim && detail.currentClaim.cancel) {
          exactRefund += toSafeNumber_(detail.currentClaim.cancel.refundExpectedAmount);
        }

        if (!exactRefund && detail.currentClaim && detail.currentClaim.return) {
          exactRefund += toSafeNumber_(detail.currentClaim.return.refundExpectedAmount);
        }

        totalRefund += exactRefund > 0 ? exactRefund : amt;
      }
    }

    return res.json({
      date: target_date,
      pay: totalPay,
      cancel: totalCancel,
      return: totalReturn,
      refund: totalRefund
    });
  } catch (error) {
    console.error('집계 에러:', error);
    return res.status(500).json({
      error: '데이터 집계 실패',
      detail: String(error)
    });
  }
});

async function fetchAllChangedStatuses_(access_token, target_date) {
  const all = [];
  let currentFrom = `${target_date}T00:00:00.000+09:00`;
  const fixedTo = `${target_date}T23:59:59.999+09:00`;
  let moreSequence = '';

  while (true) {
    const params = new URLSearchParams({
      lastChangedFrom: currentFrom,
      lastChangedTo: fixedTo
    });

    if (moreSequence) {
      params.set('moreSequence', String(moreSequence));
    }

    const url =
      `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${access_token}`
      }
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`변경 주문 조회 실패: ${response.status} ${text}`);
    }

    const json = await response.json();
    const list = json?.data?.lastChangeStatuses || [];
    const more = json?.data?.more || null;

    all.push(...list);

    if (!more || !more.moreFrom) break;

    currentFrom = more.moreFrom;
    moreSequence = more.moreSequence || '';
  }

  return all;
}

async function fetchProductOrderDetailsMap_(authHeaders, productOrderIds) {
  const map = new Map();
  const chunkSize = 300;

  for (let i = 0; i < productOrderIds.length; i += chunkSize) {
    const chunk = productOrderIds.slice(i, i + chunkSize);

    const response = await fetch(
      'https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query',
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ productOrderIds: chunk })
      }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`상세 조회 실패: ${response.status} ${text}`);
    }

    const json = await response.json();
    const rows = Array.isArray(json?.data) ? json.data : [];

    for (const row of rows) {
      const id = row?.productOrder?.productOrderId;
      if (id) map.set(id, row);
    }
  }

  return map;
}

function toSafeNumber_(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});

// 서버의 진짜 IP를 확인하기 위한 비밀 통로
app.get("/myip", async (req, res) => {
  const ipRes = await fetch("https://api.ipify.org");
  const ip = await ipRes.text();
  res.send("현재 Render 서버의 출입증(IP) 번호: " + ip);
});
