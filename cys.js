// YouTube Shorts が「クリックしたものと違う動画を再生する」「音だけ流れて画面が真っ黒になる」
// 現象の予防と是正、および再生順の制御。
//
// 実行環境について:
//   隔離環境（既定のコンテンツスクリプト）で動く。ページ本体の実行環境は使わない。
//   YouTube の CSP には strict-dynamic が入っているため <script src="moz-extension://...">
//   を差し込む方式は弾かれる。world: "MAIN" も環境によっては効かず黙って隔離環境で動く。
//   対策に必要な DOM・イベント・遷移はすべて隔離環境から扱えるので、それだけで完結させる。
//
// 再生順について:
//   チャンネル一覧の並び順に従った再生は、本来サムネイルが持つ sequenceParams で実現されている。
//   しかし sequenceParams は SPA 遷移のメモリ上の状態としてのみ運ばれ、URL には乗らない。
//   予防（クリックを通常のページ遷移に置き換える）と両立しないため、
//   一覧の並びを自分で記憶し、次へ送る操作を横取りして自分で遷移させる。

(() => {
  "use strict";

  // 二重に読み込まれても一度しか動かさない
  if (document.documentElement && document.documentElement.dataset.cys) return;

  const VERSION = "1.0.0";
  const TAG = "[CYS]";
  const LOG_KEY = "__cys_log__";
  const REPAIR_KEY = "__cys_repaired__";
  const ORDER_KEY = "__cys_order__";
  const MAX_RECORDS = 500;

  /** Shorts へのリンクのクリックを SPA 遷移ではなく通常のページ遷移にする（予防） */
  const 常に通常遷移 = true;
  /** 次へ／前へ送る操作を横取りして、記憶した一覧の並びで遷移する */
  const 自前で順送り = true;
  /** true にすると全ての記録をコンソールに出す */
  const DEBUG = false;

  /** DEBUG が false でもコンソールに出す種別 */
  const 常に表示する種別 = new Set([
    "一覧を記憶",
    "一覧を延長",
    "通常遷移に切替",
    "自前で順送り",
    "順送りの終端",
    "自動移動を検知",
    "自己復帰",
    "是正",
    "介入中止",
    "画面外を是正",
    "画面状態(手動)",
  ]);

  /** 着地からこの時間内に起きた移動だけを異常とみなす */
  const GRACE_MS = 4000;
  /** URL を監視する間隔 */
  const POLL_MS = 50;
  /** 異常を検知してから是正するまでの猶予。この間に自力で戻れば介入しない */
  const SETTLE_MS = 400;
  /** 同じ ID を何度も直し続けて再読み込みループに陥らないための有効期間 */
  const REPAIR_MEMORY_MS = 30_000;
  /** 「音だけ流れて画面が真っ黒」を調べる間隔 */
  const OFFSCREEN_CHECK_MS = 1000;
  /** 画面外の是正を連続で撃たないための間隔 */
  const OFFSCREEN_COOLDOWN_MS = 3000;
  /** 順送りを連続で撃たないための間隔 */
  const NAV_COOLDOWN_MS = 700;
  /** ホイールをこの量ためたら 1 本送る */
  const WHEEL_THRESHOLD = 40;
  /** 残りがこの本数を切ったら一覧の続きを取りに行く */
  const REFILL_MARGIN = 10;

  // ---------------------------------------------------------------
  // ログ
  // ---------------------------------------------------------------

  let log = [];
  try {
    log = JSON.parse(sessionStorage.getItem(LOG_KEY) || "[]");
  } catch {
    log = [];
  }

  const started = performance.now();

  /** @param {string} kind @param {unknown} detail */
  const add = (kind, detail) => {
    const record = {
      時刻: new Date().toISOString().slice(11, 23),
      経過ms: Math.round(performance.now() - started),
      種別: kind,
      内容: String(detail ?? "").slice(0, 2000),
      場所: location.pathname,
    };
    log.push(record);
    if (log.length > MAX_RECORDS) log.shift();
    try {
      sessionStorage.setItem(LOG_KEY, JSON.stringify(log));
    } catch {
      // 容量超過などは無視する
    }
    if (DEBUG || 常に表示する種別.has(kind)) {
      console.log(TAG, record.経過ms + "ms", kind, record.内容);
    }
  };

  /** URL から Shorts の動画 ID を取り出す。Shorts でなければ null */
  const shortsId = (url) => {
    const m = String(url).match(/\/shorts\/([\w-]{11})/);
    return m ? m[1] : null;
  };

  // 動いていることをページ側から確認できるようにする。
  // 隔離環境なので window 越しには見えないが、DOM は共有されている。
  //   確認方法: document.documentElement.dataset.cys
  const 印をつける = () => {
    try {
      document.documentElement.dataset.cys = VERSION;
    } catch {
      // まだ documentElement が無い
    }
  };
  印をつける();
  document.addEventListener("DOMContentLoaded", 印をつける);

  add("読み込み", `v${VERSION} ${location.href}`);

  // ---------------------------------------------------------------
  // 一覧の記憶
  // ---------------------------------------------------------------

  /** チャンネルの Shorts 一覧ページか */
  const 一覧ページか = () => /\/shorts\/?$/.test(location.pathname) && location.pathname !== "/shorts/";

  /** 一覧で選択中の並び順のラベルを読む。取れなければ空文字 */
  const 選択中の並び = () => {
    const 候補 = ["新しい順", "人気の動画", "古い順"];
    for (const el of document.querySelectorAll('[role="tab"], [aria-selected]')) {
      const t = (el.textContent || "").trim();
      if (候補.includes(t) && el.getAttribute("aria-selected") === "true") return t;
    }
    return "";
  };

  /** いま描画されている一覧の並びを DOM から読む（表示順そのまま、重複は除く） */
  const 一覧をDOMから読む = () => {
    const ids = [];
    for (const a of document.querySelectorAll('a[href*="/shorts/"]')) {
      const id = shortsId(a.getAttribute("href") || "");
      if (id && !ids.includes(id)) ids.push(id);
    }
    return ids;
  };

  const 一覧を保存 = (記憶) => {
    try {
      sessionStorage.setItem(ORDER_KEY, JSON.stringify(記憶));
    } catch {
      // 無視
    }
  };

  const 一覧を読む = () => {
    try {
      const raw = sessionStorage.getItem(ORDER_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------
  // 一覧の続きを取りに行く
  //
  // DOM から読めるのは描画済みの分だけなので、足りなくなったら
  // チャンネルページを取り直して並び順どおりの完全な一覧を作る。
  // 失敗しても記憶済みの範囲では動くよう、例外は握り潰す。
  // ---------------------------------------------------------------

  const ytInitialDataを取り出す = (html) => {
    const m = html.match(/var ytInitialData = (\{.+?\});<\/script>/s);
    return m ? JSON.parse(m[1]) : null;
  };

  const 動画IDを並び順に取り出す = (テキスト) =>
    [...テキスト.matchAll(/"reelWatchEndpoint":\{"videoId":"([\w-]{11})"/g)].map((m) => m[1]);

  const チップを集める = (data) => {
    const chips = [];
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      if (o.chipViewModel) {
        chips.push({
          ラベル: o.chipViewModel.text,
          token: o.chipViewModel.tapCommand?.innertubeCommand?.continuationCommand?.token,
        });
      }
      for (const k in o) walk(o[k]);
    })(data);
    return chips;
  };

  const 続きのtoken = (テキスト) => {
    const m = テキスト.match(/"continuationCommand":\{"token":"([^"]+)"/);
    return m ? m[1] : null;
  };

  let 延長中 = false;

  const 一覧を延長する = async (必要本数) => {
    if (延長中) return;
    const 記憶 = 一覧を読む();
    if (!記憶 || !記憶.出典) return;
    延長中 = true;

    try {
      const html = await (await fetch(記憶.出典, { credentials: "include" })).text();
      const data = ytInitialDataを取り出す(html);
      if (!data) return;

      const ctxRaw = html.match(/"INNERTUBE_CONTEXT":(\{.+?\}),"INNERTUBE_CONTEXT_CLIENT_NAME"/s);
      const context = ctxRaw ? JSON.parse(ctxRaw[1]) : null;

      let 本文 = JSON.stringify(data);
      let ids = 動画IDを並び順に取り出す(本文);
      let token = 続きのtoken(本文);

      // 既定以外の並びが選ばれていたら、その並びで取り直す
      const chip = チップを集める(data).find((c) => c.ラベル === 記憶.並び && c.token);
      if (chip && context) {
        const res = await fetch("/youtubei/v1/browse?prettyPrint=false", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ context, continuation: chip.token }),
        });
        本文 = await res.text();
        ids = 動画IDを並び順に取り出す(本文);
        token = 続きのtoken(本文);
      }

      // 足りるまでページを進める
      let ページ = 1;
      while (context && token && ids.length < 必要本数 && ページ < 10) {
        const res = await fetch("/youtubei/v1/browse?prettyPrint=false", {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ context, continuation: token }),
        });
        const t = await res.text();
        const 追加 = 動画IDを並び順に取り出す(t);
        if (!追加.length) break;
        ids = ids.concat(追加);
        token = 続きのtoken(t);
        ページ++;
      }

      const 重複なし = [];
      for (const id of ids) if (!重複なし.includes(id)) 重複なし.push(id);

      if (重複なし.length > 記憶.ids.length) {
        記憶.ids = 重複なし;
        一覧を保存(記憶);
        add("一覧を延長", `${記憶.並び || "既定"} の並びで ${重複なし.length} 本を保持`);
      }
    } catch (e) {
      add("一覧の延長に失敗", e);
    } finally {
      延長中 = false;
    }
  };

  // ---------------------------------------------------------------
  // 予防: Shorts へのリンクを通常のページ遷移で開く
  //
  // window の捕捉フェーズは伝播の最初なので、document 以下に付いている
  // YouTube 側のハンドラより先に止められる。
  // ---------------------------------------------------------------

  if (常に通常遷移) {
    window.addEventListener(
      "click",
      (e) => {
        // 中クリック・Ctrl/Shift クリックなどは既定の動作に任せる
        if (e.button !== 0 || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return;
        if (e.defaultPrevented) return;

        const path = typeof e.composedPath === "function" ? e.composedPath() : [];
        const anchor = path.find(
          (n) =>
            n &&
            n.tagName === "A" &&
            typeof n.getAttribute === "function" &&
            /\/shorts\/[\w-]{11}/.test(n.getAttribute("href") || "")
        );
        if (!anchor) return;

        let href;
        try {
          href = new URL(anchor.getAttribute("href"), location.origin).href;
        } catch {
          return;
        }
        const id = shortsId(href);
        if (!id) return;

        // 一覧からのクリックなら、その並びを覚えてから移動する
        if (一覧ページか()) {
          const ids = 一覧をDOMから読む();
          if (ids.includes(id)) {
            const 並び = 選択中の並び();
            一覧を保存({ 出典: location.pathname, 並び, ids, 記憶時刻: Date.now() });
            add("一覧を記憶", `${location.pathname} の ${並び || "既定"} 順で ${ids.length} 本（${id} は ${ids.indexOf(id) + 1} 本目）`);
          }
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        add("通常遷移に切替", `${id} を SPA 遷移ではなくページ遷移で開きます`);
        location.assign(href);
      },
      true
    );
  }

  // ---------------------------------------------------------------
  // 自前の順送り
  //
  // 記憶した一覧に現在の動画が含まれていれば、次へ／前へ送る操作を
  // 横取りして自分で遷移する。含まれていなければ何もせず YouTube に任せる。
  // ---------------------------------------------------------------

  let 直近の順送り = 0;
  let 蓄積delta = 0;
  let 終端を通知済み = false;

  /** 現在位置を返す。記憶が無い・一覧外なら null */
  const 現在位置 = () => {
    const id = shortsId(location.href);
    if (!id) return null;
    const 記憶 = 一覧を読む();
    if (!記憶 || !Array.isArray(記憶.ids)) return null;
    const i = 記憶.ids.indexOf(id);
    return i < 0 ? null : { 記憶, 位置: i };
  };

  /** @param {1|-1} 方向 @returns {boolean} 横取りしたか */
  const 順送りする = (方向) => {
    const 状態 = 現在位置();
    if (!状態) return false;

    const { 記憶, 位置 } = 状態;
    const 次 = 位置 + 方向;

    if (次 < 0) return true; // 先頭より前へは行かせない（操作は飲み込む）

    if (次 >= 記憶.ids.length) {
      // 続きを取りに行く。それでも無ければ YouTube に任せる
      一覧を延長する(次 + REFILL_MARGIN);
      if (!終端を通知済み) {
        終端を通知済み = true;
        add("順送りの終端", `記憶した ${記憶.ids.length} 本を使い切りました。続きを取得します`);
      }
      return false;
    }

    if (Date.now() - 直近の順送り < NAV_COOLDOWN_MS) return true;
    直近の順送り = Date.now();

    // 残りが少なくなったら先に補充しておく
    if (記憶.ids.length - 次 < REFILL_MARGIN) 一覧を延長する(次 + REFILL_MARGIN * 3);

    const 行き先 = 記憶.ids[次];
    add("自前で順送り", `${位置 + 1} 本目 -> ${次 + 1} 本目 (${行き先})`);
    location.assign(`https://www.youtube.com/shorts/${行き先}`);
    return true;
  };

  if (自前で順送り) {
    window.addEventListener(
      "wheel",
      (e) => {
        if (!shortsId(location.href)) return;
        if (!現在位置()) return;

        e.preventDefault();
        e.stopPropagation();

        蓄積delta += e.deltaY;
        if (Math.abs(蓄積delta) < WHEEL_THRESHOLD) return;
        const 方向 = 蓄積delta > 0 ? 1 : -1;
        蓄積delta = 0;
        順送りする(方向);
      },
      { capture: true, passive: false }
    );

    window.addEventListener(
      "keydown",
      (e) => {
        if (!shortsId(location.href)) return;
        if (e.ctrlKey || e.altKey || e.metaKey) return;

        const 方向 = e.key === "ArrowDown" || e.key === "PageDown" ? 1 : e.key === "ArrowUp" || e.key === "PageUp" ? -1 : 0;
        if (!方向) return;
        if (!現在位置()) return;

        if (順送りする(方向)) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );
  }

  // ---------------------------------------------------------------
  // 是正: 着地直後に勝手に別の動画へ移ったら引き戻す
  // ---------------------------------------------------------------

  const isRecentlyRepaired = (id) => {
    try {
      const raw = sessionStorage.getItem(REPAIR_KEY);
      if (!raw) return false;
      const rec = JSON.parse(raw);
      return rec.id === id && Date.now() - rec.at < REPAIR_MEMORY_MS;
    } catch {
      return false;
    }
  };

  const markRepaired = (id) => {
    try {
      sessionStorage.setItem(REPAIR_KEY, JSON.stringify({ id, at: Date.now() }));
    } catch {
      // 無視
    }
  };

  let intendedId = null;
  let landedAt = 0;
  let userActed = false;
  let settling = false;

  const watch = (id) => {
    intendedId = id;
    landedAt = Date.now();
    userActed = false;
  };

  for (const type of ["wheel", "keydown", "touchstart", "pointerdown", "mousedown"]) {
    window.addEventListener(type, () => {
      userActed = true;
    }, true);
  }

  watch(shortsId(location.href));

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;

    const current = shortsId(location.href);

    if (!current) {
      intendedId = null;
      return;
    }
    if (!intendedId || current === intendedId) {
      watch(current);
      return;
    }

    const elapsed = Date.now() - landedAt;

    if (userActed) {
      add("移動を許容", `ユーザー操作あり (${intendedId} -> ${current})`);
      watch(current);
      return;
    }
    if (elapsed >= GRACE_MS) {
      add("移動を許容", `着地から${elapsed}ms経過 (${intendedId} -> ${current})`);
      watch(current);
      return;
    }
    if (settling) return;

    settling = true;
    const target = intendedId;
    add("自動移動を検知", `${elapsed}ms で ${target} -> ${current}。${SETTLE_MS}ms 待って判断します`);

    setTimeout(() => {
      settling = false;
      const now = shortsId(location.href);

      if (now === target) {
        add("自己復帰", `YouTube 側が ${target} に戻したため介入しません`);
        return;
      }
      if (isRecentlyRepaired(target)) {
        add("介入中止", `是正済みの ${target} が再び移動したため受け入れます`);
        watch(now);
        return;
      }

      markRepaired(target);
      add("是正", `${now ?? "?"} -> ${target} へフルロードで戻します`);
      location.replace(`https://www.youtube.com/shorts/${target}`);
    }, SETTLE_MS);
  }, POLL_MS);

  // ---------------------------------------------------------------
  // 是正: 音だけ流れて画面が真っ黒
  //
  // 映像は正常に復号され CSS でも消されていないのに、再生中の video が
  // 表示領域の遥か下（実測 y=7867、表示領域は 947px）に置かれていた。
  // 表示領域から完全に外れている場合だけ中央に引き戻す。
  // ---------------------------------------------------------------

  let 直近の画面外是正 = 0;

  setInterval(() => {
    if (!shortsId(location.href)) return;

    const 主役 = [...document.querySelectorAll("video")].find((v) => !v.paused && v.videoWidth > 0);
    if (!主役) return;

    const rect = 主役.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const 完全に画面外 = rect.bottom <= 0 || rect.top >= innerHeight;
    if (!完全に画面外) return;

    if (Date.now() - 直近の画面外是正 < OFFSCREEN_COOLDOWN_MS) return;
    直近の画面外是正 = Date.now();

    add(
      "画面外を是正",
      `再生中の映像が y=${Math.round(rect.y)} にあり表示領域(高さ${innerHeight}px)の外。中央に引き戻します`
    );
    主役.scrollIntoView({ block: "center", behavior: "auto" });
  }, OFFSCREEN_CHECK_MS);

  // ---------------------------------------------------------------
  // 診断
  // ---------------------------------------------------------------

  const 名前 = (el) => {
    if (!el) return "なし";
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
        : "";
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + cls;
  };

  const 画面状態 = () => {
    const videos = [...document.querySelectorAll("video")];

    const 明細 = videos.map((v, i) => {
      const rect = v.getBoundingClientRect();
      const style = getComputedStyle(v);
      let frames = "?";
      try {
        frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : "?";
      } catch {
        // 取得できない環境は ? のまま
      }
      return [
        `#${i}`,
        `解像度=${v.videoWidth}x${v.videoHeight}`,
        `復号=${frames}`,
        `readyState=${v.readyState}`,
        v.paused ? "停止" : "再生",
        v.muted ? "消音" : "音あり",
        `位置=(${Math.round(rect.x)},${Math.round(rect.y)})`,
        `枠=${Math.round(rect.width)}x${Math.round(rect.height)}`,
        `display=${style.display}`,
        `visibility=${style.visibility}`,
        `opacity=${style.opacity}`,
      ].join(" ");
    });

    const 主役 = videos.find((v) => !v.paused && v.videoWidth > 0) ?? videos[0];
    let 重なり = "主役なし";

    if (主役) {
      const rect = 主役.getBoundingClientRect();
      const cx = Math.round(rect.x + rect.width / 2);
      const cy = Math.round(rect.y + rect.height / 2);
      const 画面内 =
        rect.width > 0 && rect.height > 0 && cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;

      if (!画面内) {
        重なり = `主役が画面外 中心=(${cx},${cy}) 表示領域=${innerWidth}x${innerHeight}`;
      } else {
        const 最前面 = document.elementFromPoint(cx, cy);
        const 見えている = 最前面 === 主役 || 主役.contains(最前面);
        重なり = `中心(${cx},${cy})の最前面=${名前(最前面)} 主役が見えている=${見えている ? "はい" : "いいえ"}`;
      }
    }

    const 状態 = 現在位置();
    const 順番 = 状態
      ? `記憶: ${状態.記憶.出典} ${状態.記憶.並び || "既定"}順 ${状態.記憶.ids.length}本中 ${状態.位置 + 1}本目`
      : "記憶: なし（YouTube 任せ）";

    return [`URL上のID=${shortsId(location.href) ?? "?"}`, 順番, `video要素=${videos.length}`, 重なり, ...明細]
      .filter(Boolean)
      .join(" ｜ ");
  };

  // 隔離環境なのでページのコンソールから window 越しには触れない。
  // DOM イベントは共有されているので、それを入口にする。
  //
  //   状態を見る:   document.dispatchEvent(new Event("cys-画面"))
  //   ログを見る:   document.dispatchEvent(new Event("cys-ログ"))
  //   ログを消す:   document.dispatchEvent(new Event("cys-消去"))
  //
  // 記録は sessionStorage にも入るので、ページのコンソールから直接読める。
  //   JSON.parse(sessionStorage.getItem("__cys_log__"))
  //   JSON.parse(sessionStorage.getItem("__cys_order__"))
  document.addEventListener("cys-画面", () => {
    add("画面状態(手動)", 画面状態());
  });
  document.addEventListener("cys-ログ", () => {
    console.log(TAG, `v${VERSION} 記録 ${log.length} 件`);
    console.log(JSON.stringify(log, null, 1));
  });
  document.addEventListener("cys-消去", () => {
    log = [];
    try {
      sessionStorage.removeItem(LOG_KEY);
      sessionStorage.removeItem(REPAIR_KEY);
    } catch {
      // 無視
    }
    console.log(TAG, "記録を消去しました");
  });

  add("計測開始", `v${VERSION} 隔離環境で動作中`);
})();
