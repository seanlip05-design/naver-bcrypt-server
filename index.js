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

const express = require('express');
const fetch = require('node-fetch');
const app = express();
app.use(express.json());

//
app.post('/naver-daily-summary', async (req, res) => {
  try {
    const { access_token, target_date } = req.body;

    if (!access_token || !target_date) {
      return res.status(400).json({
        error: 'access_token / target_date 필요'
      });
    }

    // 1) 결제금액 먼저 계산 (블로거 방식)
    const totalPay = await getPaidAmountByDate_(access_token, target_date);

    // 2) 취소/반품/환불은 기존 방식 유지
    const { totalCancel, totalReturn, totalRefund } =
      await getClaimSummaryByDate_(access_token, target_date);

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


async function getPaidAmountByDate_(access_token, target_date) {
  let totalPay = 0;

  // 블로거 코드처럼 PAYED_DATETIME 기준
  // from만 주면 해당 시점부터 24시간 범위로 조회되는 방식에 맞춰 사용
  let from = `${target_date}T00:00:00.000+09:00`;
  let moreSequence = '';

  while (true) {
    const params = new URLSearchParams({
      from,
      rangeType: 'PAYED_DATETIME'
    });

    // ⚠️ 여기서 productOrderStatuses=PAYED를 강하게 거는 건 비추천
    // 이미 배송중/배송완료로 넘어간 주문이 빠질 수 있음
    // 블로거 코드처럼 넣고 싶으면 아래 줄 사용
    // params.set('productOrderStatuses', 'PAYED');

    if (moreSequence) {
      params.set('moreSequence', String(moreSequence));
    }

    const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders?${params.toString()}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'Content-Type': 'application/json'
      }
    });

    const raw = await response.text();

    if (!response.ok) {
      throw new Error(`결제주문 조회 실패: ${response.status} ${raw}`);
    }

    const data = JSON.parse(raw);

    // 응답 구조 방어적으로 처리
    const rows =
      data?.data?.productOrders ||
      data?.data?.contents ||
      data?.data ||
      [];

    if (Array.isArray(rows)) {
      rows.forEach(item => {
        const po = item.productOrder || item;
        const amt = Number(po.totalPaymentAmount || 0);
        totalPay += amt;
      });
    }

    const more = data?.data?.more;

    if (!more || !more.moreFrom) {
      break;
    }

    from = more.moreFrom;
    moreSequence = more.moreSequence || '';
  }

  return totalPay;
}


async function getClaimSummaryByDate_(access_token, target_date) {
  const params = new URLSearchParams({
    lastChangedFrom: `${target_date}T00:00:00.000+09:00`,
    lastChangedTo: `${target_date}T23:59:59.999+09:00`
  });

  const url = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/last-changed-statuses?${params.toString()}`;

  const response = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${access_token}`
    }
  });

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(`변경주문 조회 실패: ${response.status} ${raw}`);
  }

  const data = JSON.parse(raw);

  const statuses = data?.data?.lastChangeStatuses || [];

  if (statuses.length === 0) {
    return {
      totalCancel: 0,
      totalReturn: 0,
      totalRefund: 0
    };
  }

  const idMap = {};
  const allIds = [];

  statuses.forEach(s => {
    if (!s.productOrderId) return;
    idMap[s.productOrderId] = s.lastChangedType;
    allIds.push(s.productOrderId);
  });

  const detailsUrl = `https://api.commerce.naver.com/external/v1/pay-order/seller/product-orders/query`;
  const detailsResponse = await fetch(detailsUrl, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${access_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ productOrderIds: allIds })
  });

  const detailsRaw = await detailsResponse.text();

  if (!detailsResponse.ok) {
    throw new Error(`상세조회 실패: ${detailsResponse.status} ${detailsRaw}`);
  }

  const detailsData = JSON.parse(detailsRaw);

  let totalCancel = 0;
  let totalReturn = 0;
  let totalRefund = 0;

  if (detailsData.data && Array.isArray(detailsData.data)) {
    detailsData.data.forEach(detail => {
      const po = detail.productOrder || {};
      const id = po.productOrderId;
      const lastType = idMap[id];
      const amt = Number(po.totalPaymentAmount || 0);

      if (lastType === 'CLAIM_COMPLETED') {
        if (po.productOrderStatus === 'CANCELED') {
          totalCancel += amt;
        } else if (po.productOrderStatus === 'RETURNED') {
          totalReturn += amt;
        } else {
          if (po.claimType === 'CANCEL' || po.claimType === 'ADMIN_CANCEL') {
            totalCancel += amt;
          } else if (po.claimType === 'RETURN') {
            totalReturn += amt;
          }
        }

        let exactRefund = 0;

        if (detail.completedClaims && detail.completedClaims.length > 0) {
          detail.completedClaims.forEach(c => {
            exactRefund += Number(c.refundAmount || c.totalRefundAmount || 0);
          });
        } else if (detail.claim && detail.claim.refundInfo) {
          exactRefund += Number(detail.claim.refundInfo.refundAmount || 0);
        }

        totalRefund += (exactRefund > 0 ? exactRefund : amt);
      }
    });
  }

  return {
    totalCancel,
    totalReturn,
    totalRefund
  };
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
