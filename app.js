/* ============================================================
   错题本 · 逻辑
   纯前端 · IndexedDB 存储 · KaTeX 渲染
   ============================================================ */

(function () {
  "use strict";

  /* ---------------- 常量 ---------------- */

  var DB_NAME = "mistake-book";
  var DB_VER = 4;
  var STORE = "mistakes";
  var SUM_STORE = "summaries";
  var MEMO_STORE = "memos";
  var DRAFT_STORE = "drafts";   // 总结跑到一半的草稿，关页面也不丢

  var SUBJECTS = [
    "高等数学", "线性代数", "概率论", "大学物理",
    "C语言", "英语", "其他"
  ];

  // 关键词 → 学科，用于猜分类
  var SUBJECT_HINTS = {
    "高等数学": ["极限", "导数", "微分", "积分", "罗尔", "拉格朗日", "泰勒",
      "级数", "连续", "可导", "中值", "偏导", "重积分", "曲线积分", "敛散"],
    "线性代数": ["矩阵", "行列式", "特征值", "特征向量", "向量组", "秩",
      "线性方程组", "二次型", "相似", "正交"],
    "概率论": ["概率", "期望", "方差", "分布", "随机变量", "大数定律",
      "中心极限", "条件概率", "协方差"],
    "大学物理": ["受力", "加速度", "动量", "能量守恒", "电场", "磁场",
      "热力学", "波动", "折射"],
    "C语言": ["指针", "malloc", "数组", "结构体", "printf", "include",
      "while", "for", "函数", "内存", "编译"],
    "英语": ["grammar", "tense", "clause", "phrase", "vocabulary"]
  };

  /* ---------------- IndexedDB ---------------- */

  var dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VER);

      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: "id" });
          os.createIndex("createdAt", "createdAt");
          os.createIndex("subject", "subject");
        }
        if (!db.objectStoreNames.contains(SUM_STORE)) {
          var ss = db.createObjectStore(SUM_STORE, { keyPath: "id" });
          ss.createIndex("createdAt", "createdAt");
        }
        if (!db.objectStoreNames.contains(MEMO_STORE)) {
          var ms = db.createObjectStore(MEMO_STORE, { keyPath: "id" });
          ms.createIndex("updatedAt", "updatedAt");
        }
        if (!db.objectStoreNames.contains(DRAFT_STORE)) {
          db.createObjectStore(DRAFT_STORE, { keyPath: "id" });
        }
      };

      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });

    return dbPromise;
  }

  function dbGetAll(store) {
    store = store || STORE;
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readonly");
        var req = tx.objectStore(store).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function dbPut(item, store) {
    store = store || STORE;
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(item);
        tx.oncomplete = function () { resolve(item); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function dbDelete(id, store) {
    store = store || STORE;
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, "readwrite");
        tx.objectStore(store).delete(id);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  /* ---------------- 状态 ---------------- */

  var state = {
    view: "book",
    items: [],
    memos: [],
    filterSubject: "",
    filterTag: "",
    keyword: "",
    editingId: null,
    editingImage: "",
    editingCrop: "",
    viewingId: null,
    viewerImg: null
  };

  /* ---------------- 工具 ---------------- */

  function $(id) { return document.getElementById(id); }

  function uid() {
    return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // 模型有时会把 LaTeX 直接写进知识点/答案里（没包 $），这里补上 $...$
  function wrapBareLatex(s) {
    s = String(s == null ? "" : s);
    if (!s || s.indexOf("\\") < 0) return s;

    // 公式片段里的字符：非中文、非全角、非空白
    function isMathChar(ch) {
      if (!ch) return false;
      if (ch.charCodeAt(0) > 0x2e80) return false;
      return ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r";
    }

    var out = "";
    var i = 0;

    while (i < s.length) {
      if (s.charAt(i) === "$") {
        var j = s.indexOf("$", i + 1);
        if (j > i) { out += s.slice(i, j + 1); i = j + 1; continue; }
      }

      if (s.charAt(i) === "\\") {
        var a = i;
        while (a > 0 && isMathChar(s.charAt(a - 1))) a--;

        var b = i;
        while (b < s.length && isMathChar(s.charAt(b))) b++;

        var seg = s.slice(a, b);
        if (seg.indexOf("\\") >= 0 && /\\[a-zA-Z]/.test(seg)) {
          // a~i 这段已经逐字写进 out 了，先退回去，避免重复
          out = out.slice(0, out.length - (i - a));
          out += "$" + seg + "$";
          i = b;
          continue;
        }
      }

      out += s.charAt(i);
      i++;
    }

    return out;
  }

  // 先补 $ 再做 HTML 转义
  function richText(s) {
    return escapeHtml(wrapBareLatex(s));
  }

  function fmtDate(ts) {
    var d = new Date(ts);
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  var toastTimer = null;

  // 第三个参数给一个「撤销」之类的按钮，点一下就跑它
  function toast(msg, actionLabel, onAction) {
    var el = $("toast");
    el.innerHTML = "";

    var span = document.createElement("span");
    span.textContent = msg;
    el.appendChild(span);

    if (actionLabel && onAction) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "toast__act";
      b.textContent = actionLabel;
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        hideToast();
        onAction();
      });
      el.appendChild(b);
    }

    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, actionLabel ? 6000 : 2000);
  }

  function hideToast() {
    var el = $("toast");
    if (el) el.classList.remove("show");
    clearTimeout(toastTimer);
  }

  // 渲染 LaTeX（KaTeX 没加载成功就原样显示）
  function renderMath(el) {
    if (!el || typeof window.renderMathInElement !== "function") return;
    try {
      window.renderMathInElement(el, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\[", right: "\\]", display: true },
          { left: "\\(", right: "\\)", display: false }
        ],
        throwOnError: false,
        macros: {
          "\\arccot": "\\operatorname{arccot}",
          "\\arcsec": "\\operatorname{arcsec}",
          "\\arccsc": "\\operatorname{arccsc}",
          "\\sech": "\\operatorname{sech}",
          "\\csch": "\\operatorname{csch}",
          "\\ctg": "\\cot",
          "\\tg": "\\tan",
          "\\cth": "\\coth",
          "\\sh": "\\sinh",
          "\\ch": "\\cosh"
        },
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code"]
      });
    } catch (e) {
      /* 渲染失败就当纯文本 */
    }
  }

  /* ---------------- 图片处理 ---------------- */

  // 压缩：长边不超过 1600px，JPEG 质量 0.82
  function compressImage(file) {
    return new Promise(function (resolve, reject) {
      if (!file || !file.type || file.type.indexOf("image/") !== 0) {
        reject(new Error("不是图片文件"));
        return;
      }

      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        var maxW = 1600;
        var w = img.naturalWidth;
        var h = img.naturalHeight;

        if (w > maxW) {
          h = Math.round((h * maxW) / w);
          w = maxW;
        }

        var canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);

        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error("图片读不出来"));
      };

      img.src = url;
    });
  }

  // 同步用的小图：长边 480、webp 0.55，一张十来 KB。
  // 原图太大塞不进 Gist，小图能把「手机上也能看见图」这件事解决掉。
  function thumbOf(dataUrl, maxW) {
    return new Promise(function (resolve) {
      if (!dataUrl) { resolve(""); return; }

      var img = new Image();

      img.onload = function () {
        try {
          var max = maxW || 480;
          var w = img.naturalWidth || max;
          var h = img.naturalHeight || max;

          if (w > max) {
            h = Math.round((h * max) / w);
            w = max;
          }

          var c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          var ctx = c.getContext("2d");
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, w, h);
          ctx.drawImage(img, 0, 0, w, h);

          var out = c.toDataURL("image/webp", 0.55);
          if (out.indexOf("data:image/webp") !== 0) out = c.toDataURL("image/jpeg", 0.55);
          resolve(out);
        } catch (e) {
          resolve("");
        }
      };

      img.onerror = function () { resolve(""); };
      img.src = dataUrl;
    });
  }

  // 便宜的指纹：同一张图再放进来一次就认出来了（不追求密码学强度）
  function hashOf(str) {
    var s = String(str || "");
    var h1 = 0x811c9dc5 >>> 0;
    var h2 = 0x9e3779b9 >>> 0;

    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 = (((h1 ^ c) * 16777619) >>> 0);
      h2 = (((h2 * 33) ^ c) >>> 0);
    }

    return h1.toString(16) + "-" + h2.toString(16) + "-" + s.length.toString(16);
  }

  /* ---------------- 文档：PDF / Word / PPT / txt ---------------- */

  var MAX_UNITS = 60;        // 图片段 + 文档段 一共别超过这么多
  var MAX_DOC_PAGES = 60;    // 一个 PDF 最多读这么多页
  var DOC_PIECE = 1600;      // 一段文字大概多长

  function fileExt(name) {
    var m = String(name || "").toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : "";
  }

  function isImageFile(f) {
    return !!(f && f.type && f.type.indexOf("image/") === 0);
  }

  function isDocFile(f) {
    var ext = fileExt(f && f.name);
    return ext === "pdf" || ext === "docx" || ext === "pptx" ||
      ext === "txt" || ext === "md" || ext === "markdown" || ext === "doc";
  }

  function baseName(name) {
    return String(name || "文档").replace(/\.[^.]+$/, "").slice(0, 18);
  }

  // 丢进来的东西统一从这儿进门：图片走 OCR，文档先抽成文字/页图
  function addFiles(files) {
    var arr = Array.prototype.slice.call(files || []);
    var pics = arr.filter(isImageFile);
    var docs = arr.filter(isDocFile);
    var rest = arr.filter(function (f) { return !isImageFile(f) && !isDocFile(f); });

    if (pics.length) addImages(pics);

    if (rest.length) {
      toast("跳过 " + rest.length + " 个不认识的格式（要图片 / PDF / Word / PPT / txt）");
    }

    docs.forEach(function (f) { addDoc(f); });
  }

  async function addDoc(file) {
    var ext = fileExt(file.name);

    if (ext === "doc") {
      toast("老的 .doc 读不了，另存成 .docx 或者 PDF 再丢进来");
      return;
    }

    var room = MAX_UNITS - (sum.images.length + sum.texts.length);
    if (room <= 0) {
      toast("已经 " + MAX_UNITS + " 段了，先清一清");
      return;
    }

    if (!resetProgressIfNeeded("文档")) return;

    sumStatus("正在读《" + file.name + "》…（大文件要等几秒）");

    var stopBtnD = $("sumStop");
    sum.stop = false;
    sum.reading = true;
    if (stopBtnD) { stopBtnD.hidden = false; stopBtnD.disabled = false; }

    try {
      var out;

      if (ext === "pdf") out = await readPdfDoc(file, room);
      else if (ext === "docx") out = await readDocxDoc(file);
      else if (ext === "pptx") out = await readPptxDoc(file);
      else out = await readPlainDoc(file);

      var imgs = out.images || [];
      var txts = out.texts || [];
      var dup = 0;
      var added = 0;
      var overflow = 0;

      imgs.forEach(function (it) {
        if (sum.images.length + sum.texts.length >= MAX_UNITS) { overflow++; return; }
        var h = hashOf(it.url);
        if (sum.hashes[h]) { dup++; return; }
        sum.hashes[h] = 1;
        sum.docImgs[sum.images.length] = 1;   // 记一笔：这页是文档里的扫描页
        sum.images.push(it.url);
        sum.thumbs.push(it.thumb || "");
        added++;
      });

      txts.forEach(function (t) {
        if (sum.images.length + sum.texts.length >= MAX_UNITS) { overflow++; return; }
        sum.texts.push(t);
        added++;
      });

      renderThumbs();

      if (!added) {
        toast("《" + baseName(file.name) + "》里没读出东西来");
        return;
      }

      var bits = [];
      if (imgs.length) bits.push(imgs.length + " 页图（要识别）");
      if (txts.length) bits.push(txts.length + " 段文字（不用识别）");

      sumStatus("《" + baseName(file.name) + "》" + (sum.stop ? "读了一半：" : "读好了：") +
        bits.join(" + ") +
        (dup ? "，跳过 " + dup + " 张重复的" : "") +
        (overflow ? "，超出" + MAX_UNITS + "段的部分没放进来" : "") +
        "。点「开始总结」", overflow ? "err" : "ok");
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);
      sumStatus("读《" + baseName(file.name) + "》失败：" + msg, "err");
    } finally {
      sum.reading = false;
      sum.stop = false;
      if (!sum.busy && stopBtnD) stopBtnD.hidden = true;
    }
  }

  /* ---------- PDF ---------- */

  function plainPageText(tc) {
    var parts = [];
    (tc.items || []).forEach(function (it) {
      if (it && it.str) parts.push(it.str);
    });
    return parts.join(" ").replace(/\s+/g, " ").trim();
  }

  function pageToImage(page, scale) {
    var viewport = page.getViewport({ scale: scale || 1.7 });
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    var ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    return page.render({ canvasContext: ctx, viewport: viewport }).promise.then(function () {
      return canvas.toDataURL("image/jpeg", 0.82);
    });
  }

  async function readPdfDoc(file, room) {
    if (!window.pdfjsLib) throw new Error("PDF 组件没加载上，刷新一下页面再试");

    try {
      pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
    } catch (e) { /* 用主线程也能跑 */ }

    var buf = await file.arrayBuffer();
    var doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;

    var out = { images: [], texts: [] };
    var pages = Math.min(doc.numPages, Math.min(MAX_DOC_PAGES, room));

    for (var p = 1; p <= pages; p++) {
      if (sum.stop) break;

      sumStatus("正在读 PDF 第 " + p + "/" + pages + " 页…");

      var page = await doc.getPage(p);
      var text = "";

      // 文字版 PDF 直接抽字，一分钱都不用花；抽不出来（扫描件）才转图去 OCR
      try {
        text = plainPageText(await page.getTextContent());
      } catch (e) {
        text = "";
      }

      if (text.length >= 25) {
        out.texts.push({
          label: "《" + baseName(file.name) + "》第 " + p + " 页",
          text: text.slice(0, DOC_PIECE * 4)
        });
      } else {
        var url = await pageToImage(page, 1.7);
        out.images.push({ url: url, thumb: await thumbOf(url) });
      }
    }

    if (doc.numPages > pages) {
      toast("这个 PDF 有 " + doc.numPages + " 页，先读了前 " + pages + " 页");
    }

    try { doc.destroy(); } catch (e) { /* 忽略 */ }

    return out;
  }

  /* ---------- zip（docx / pptx 其实都是 zip） ---------- */

  async function openZip(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var dv = new DataView(arrayBuffer);

    var eocd = -1;
    var lowest = Math.max(0, bytes.length - 66000);

    for (var i = bytes.length - 22; i >= lowest; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 && bytes[i + 3] === 0x06) {
        eocd = i;
        break;
      }
    }

    if (eocd < 0) throw new Error("这个文件不是标准的 docx/pptx");

    var count = dv.getUint16(eocd + 10, true);
    var cdOff = dv.getUint32(eocd + 16, true);
    var index = {};
    var p = cdOff;

    for (var n = 0; n < count; n++) {
      if (p + 46 > bytes.length) break;
      if (dv.getUint32(p, true) !== 0x02014b50) break;

      var method = dv.getUint16(p + 10, true);
      var compSize = dv.getUint32(p + 20, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var commentLen = dv.getUint16(p + 32, true);
      var localOff = dv.getUint32(p + 42, true);
      var name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));

      index[name] = { method: method, compSize: compSize, localOff: localOff, nameLen: nameLen };
      p += 46 + nameLen + extraLen + commentLen;
    }

    return { bytes: bytes, dv: dv, index: index };
  }

  async function zipText(zip, name) {
    var e = zip.index[name];
    if (!e) return null;

    var lo = e.localOff;
    if (zip.dv.getUint32(lo, true) !== 0x04034b50) return null;

    var nameLen = zip.dv.getUint16(lo + 26, true);
    var extraLen = zip.dv.getUint16(lo + 28, true);
    var start = lo + 30 + nameLen + extraLen;
    var data = zip.bytes.subarray(start, start + e.compSize);

    if (e.method === 0) return new TextDecoder().decode(data);

    if (typeof DecompressionStream === "undefined") {
      throw new Error("这个浏览器解不开 docx/pptx，换新版 Edge 或 Chrome");
    }

    var stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    var buf = await new Response(stream).arrayBuffer();
    return new TextDecoder().decode(buf);
  }

  function xmlToText(xml) {
    var s = String(xml || "");
    s = s.replace(/<w:tab[^>]*\/>/g, "\t")
      .replace(/<w:br[^>]*\/>/g, "\n")
      .replace(/<a:br[^>]*\/>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<\/a:p>/g, "\n")
      .replace(/<[^>]+>/g, "");
    s = s.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(Number(d)); });
    return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // 长文字按段落切成一段一段，别一次塞给模型
  function chunkText(text, size) {
    var max = size || DOC_PIECE;
    var paras = String(text || "").split(/\n+/).map(function (t) { return t.trim(); }).filter(Boolean);
    var parts = [];
    var cur = "";

    paras.forEach(function (p) {
      if (p.length > max) {
        if (cur) { parts.push(cur); cur = ""; }
        for (var i = 0; i < p.length; i += max) parts.push(p.slice(i, i + max));
        return;
      }
      if ((cur + "\n" + p).length > max) { parts.push(cur); cur = p; }
      else cur = cur ? cur + "\n" + p : p;
    });

    if (cur) parts.push(cur);
    return parts;
  }

  async function readDocxDoc(file) {
    var zip = await openZip(await file.arrayBuffer());
    var xml = await zipText(zip, "word/document.xml");
    if (!xml) throw new Error("Word 里没找到正文");

    var text = xmlToText(xml);
    if (!text.trim()) throw new Error("这份 Word 是空的，或者只有图片");

    var pieces = chunkText(text);
    return {
      images: [],
      texts: pieces.map(function (t, i) {
        return { label: "《" + baseName(file.name) + "》第 " + (i + 1) + " 段", text: t };
      })
    };
  }

  async function readPptxDoc(file) {
    var zip = await openZip(await file.arrayBuffer());

    var names = Object.keys(zip.index).filter(function (n) {
      return /^ppt\/slides\/slide\d+\.xml$/.test(n);
    });

    if (!names.length) throw new Error("PPT 里没找到幻灯片");

    names.sort(function (a, b) {
      var na = Number((a.match(/(\d+)/) || [])[1] || 0);
      var nb = Number((b.match(/(\d+)/) || [])[1] || 0);
      return na - nb;
    });

    var texts = [];
    for (var i = 0; i < names.length; i++) {
      var xml = await zipText(zip, names[i]);
      var text = xmlToText(xml);
      if (!text.trim()) continue;

      texts.push({
        label: "《" + baseName(file.name) + "》第 " + (i + 1) + " 页",
        text: text.slice(0, DOC_PIECE * 3)
      });
    }

    if (!texts.length) throw new Error("这份 PPT 里全是图，没有字（那就截屏丢进来识别吧）");
    return { images: [], texts: texts };
  }

  async function readPlainDoc(file) {
    var text = await file.text();
    if (!text.trim()) throw new Error("文件是空的");

    var pieces = chunkText(text);
    return {
      images: [],
      texts: pieces.map(function (t, i) {
        return { label: "《" + baseName(file.name) + "》第 " + (i + 1) + " 段", text: t };
      })
    };
  }

  /* ---------------- 自动分类 ---------------- */

  function guessSubject(text) {
    if (!text) return "";
    var best = "";
    var bestScore = 0;

    Object.keys(SUBJECT_HINTS).forEach(function (subject) {
      var words = SUBJECT_HINTS[subject];
      var score = 0;
      words.forEach(function (w) {
        if (text.indexOf(w) !== -1) score++;
      });
      if (score > bestScore) {
        bestScore = score;
        best = subject;
      }
    });

    return bestScore > 0 ? best : "";
  }

  /* ---------------- 渲染：侧栏 ---------------- */

  function renderSidebar() {
    // 学科
    var list = $("subjectList");
    var counts = {};
    state.items.forEach(function (it) {
      var s = it.subject || "其他";
      counts[s] = (counts[s] || 0) + 1;
    });

    var html = '<li class="' + (state.filterSubject === "" ? "active" : "") +
      '" data-subject="">全部<span class="count">' + state.items.length + "</span></li>";

    SUBJECTS.forEach(function (s) {
      if (!counts[s] && state.filterSubject !== s) return;
      html += '<li class="' + (state.filterSubject === s ? "active" : "") +
        '" data-subject="' + escapeHtml(s) + '">' + escapeHtml(s) +
        '<span class="count">' + (counts[s] || 0) + "</span></li>";
    });

    list.innerHTML = html;
    list.querySelectorAll("li").forEach(function (li) {
      li.addEventListener("click", function () {
        state.filterSubject = li.dataset.subject;
        render();
        if (isNarrow()) setFilterPanel(false);
      });
    });

    // 标签
    var tagCount = {};
    state.items.forEach(function (it) {
      (it.tags || []).forEach(function (t) {
        tagCount[t] = (tagCount[t] || 0) + 1;
      });
    });

    var tags = Object.keys(tagCount).sort(function (a, b) {
      return tagCount[b] - tagCount[a];
    }).slice(0, 24);

    var cloud = $("tagCloud");
    if (!tags.length) {
      cloud.innerHTML = '<span class="stat-hint">还没有标签</span>';
    } else {
      cloud.innerHTML = tags.map(function (t) {
        return '<span class="tag-chip ' + (state.filterTag === t ? "active" : "") +
          '" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + "</span>";
      }).join("");

      cloud.querySelectorAll(".tag-chip").forEach(function (chip) {
        chip.addEventListener("click", function () {
          state.filterTag = state.filterTag === chip.dataset.tag ? "" : chip.dataset.tag;
          render();
          if (isNarrow()) setFilterPanel(false);
        });
      });
    }

    $("statTotal").textContent = state.items.length;
    updateReviewBadge();
  }

  /* ---------------- 渲染：列表 ---------------- */

  function matchesFilters(it) {
    if (state.filterSubject && (it.subject || "其他") !== state.filterSubject) return false;
    if (state.filterTag && (it.tags || []).indexOf(state.filterTag) === -1) return false;

    if (state.keyword) {
      var k = state.keyword.toLowerCase();
      var hay = [
        it.title || "", it.answer || "", it.note || "",
        (it.tags || []).join(" "), it.subject || ""
      ].join(" ").toLowerCase();
      if (hay.indexOf(k) === -1) return false;
    }

    return true;
  }

  function renderList() {
    var listEl = $("list");
    var emptyEl = $("empty");

    var shown = state.items.filter(matchesFilters).sort(function (a, b) {
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    if (!state.items.length) {
      listEl.innerHTML = "";
      emptyEl.classList.add("show");
      return;
    }

    emptyEl.classList.remove("show");

    if (!shown.length) {
      listEl.innerHTML =
        '<div class="stat-hint" style="grid-column:1/-1;padding:40px 0;text-align:center">' +
        "这个筛选下没有错题</div>";
      return;
    }

    listEl.innerHTML = shown.map(function (it) {
      // 有截好的题目图就优先用它，省得一眼扫到解析
      var thumbSrc = it.imageCrop || it.image || it.thumb;
      var thumb = thumbSrc
        ? '<img class="card__thumb" src="' + thumbSrc + '" alt="" loading="lazy" />'
        : it.imgLite
          ? '<div class="card__thumb card__thumb--empty" title="图片只存在另一台设备上">🖼️</div>'
          : '<div class="card__thumb card__thumb--empty">📄</div>';

      var title = it.title
        ? '<div class="card__title">' + escapeHtml(it.title.slice(0, 90)) + "</div>"
        : '<div class="card__title is-empty">（还没填题目）</div>';

      var tags = (it.tags || []).slice(0, 4).map(function (t) {
        return '<span class="card__tag">' + escapeHtml(t) + "</span>";
      }).join("");

      return '<article class="card" data-id="' + it.id + '">' +
        thumb +
        '<div class="card__body">' +
          '<div class="card__subject">' + escapeHtml(it.subject || "其他") + "</div>" +
          title +
          '<div class="card__tags">' + tags + "</div>" +
          '<div class="card__date">' + fmtDate(it.createdAt) + "</div>" +
        "</div>" +
        "</article>";
    }).join("");

    // 卡片标题里的 $公式$ 也渲染出来
    listEl.querySelectorAll(".card__title").forEach(function (el) {
      renderMath(el);
    });

    listEl.querySelectorAll(".card").forEach(function (card) {
      card.addEventListener("click", function () {
        openViewer(card.dataset.id);
      });
    });
  }

  function render() {
    renderSidebar();
    renderList();
  }

  /* ---------------- 表单 ---------------- */

  function openForm(item) {
    state.editingId = item ? item.id : null;
    state.editingImage = item && item.image ? item.image : "";
    state.editingCrop = item && item.imageCrop ? item.imageCrop : "";

    $("drawerTitle").textContent = item ? "编辑错题" : "记一道错题";
    $("fId").value = item ? item.id : "";
    $("fSubject").value = item ? (item.subject || "其他") : "其他";
    $("fTags").value = item ? (item.tags || []).join(", ") : "";
    $("fTitle").value = item ? (item.title || "") : "";
    $("fAnswer").value = item ? (item.answer || "") : "";
    $("fNote").value = item ? (item.note || "") : "";

    var preview = $("preview");
    var hint = $("dropHint");
    var clearBtn = $("btnClearImage");

    if (state.editingImage) {
      preview.src = state.editingImage;
      preview.hidden = false;
      hint.style.display = "none";
      clearBtn.hidden = false;
    } else {
      preview.src = "";
      preview.hidden = true;
      hint.style.display = "flex";
      clearBtn.hidden = true;
    }

    updateFormPreview();
    setOcrStatus("");
    updateOcrHint();
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
  }

  function closeForm() {
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    state.editingId = null;
    state.editingImage = "";
    state.editingCrop = "";
  }

  function updateFormPreview() {
    var box = $("formPreview");
    var parts = [
      $("fTitle").value,
      $("fAnswer").value ? "答案：" + $("fAnswer").value : "",
      $("fNote").value ? "解析：" + $("fNote").value : ""
    ].filter(Boolean);

    if (!parts.length) {
      box.textContent = "（上面写的内容会在这里渲染公式）";
      box.style.color = "#4a6685";
      return;
    }

    box.style.color = "";
    box.innerHTML = escapeHtml(parts.join("\n"));
    renderMath(box);
  }

  async function saveForm(e) {
    e.preventDefault();

    var id = $("fId").value || uid();
    var title = $("fTitle").value.trim();
    var tagsRaw = $("fTags").value;
    var tags = tagsRaw.split(/[,，、\s]+/).map(function (t) {
      return t.trim();
    }).filter(Boolean);

    var subject = $("fSubject").value;
    var guess = guessSubject(title + " " + $("fNote").value);

    // 学科是「其他」但有把握的话，自动归一下
    if ((!subject || subject === "其他") && guess) {
      subject = guess;
    }

    var existing = state.items.find(function (it) { return it.id === id; });
    var now = Date.now();

    var item = {
      id: id,
      image: state.editingImage || "",
      imageCrop: state.editingCrop || "",
      thumb: state.editingImage ? await thumbOf(state.editingImage) : "",
      subject: subject || "其他",
      title: title,
      answer: $("fAnswer").value.trim(),
      note: $("fNote").value.trim(),
      tags: tags,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now
    };

    await dbPut(item);
    await reload();

    closeForm();
    toast(existing ? "改好了" : "收进错题本了");
  }

  /* ---------------- 查看器 ---------------- */

  function openViewer(id) {
    var it = state.items.find(function (x) { return x.id === id; });
    if (!it) return;

    state.viewingId = id;

    var html = "";

    state.viewerImg = null;

    var viewerSrc = it.image || it.thumb || "";

    if (viewerSrc) {
      var crop = it.imageCrop || "";

      if (crop && it.image) state.viewerImg = { crop: crop, full: it.image };

      html += '<div class="viewer__fig">' +
        '<img class="viewer__img" src="' + (crop || viewerSrc) + '" alt="题目" />' +
        '<div class="viewer__figbar">' +
          '<span class="viewer__fighint">' +
            (it.image
              ? (crop ? "这里只截了题干，解析在下面 👇" : "还没截题，点右边就只留题干")
              : "这张图在另一台设备上，这里是缩略图") +
          "</span>" +
          '<span class="viewer__figacts">' +
            (it.image
              ? '<button type="button" class="viewer__toggle viewer__retake" ' +
                'title="重新认一遍题目在图的哪一块，文字不动">✂️ 重新截</button>'
              : "") +
            (crop
              ? '<button type="button" class="viewer__toggle viewer__swap" data-mode="crop" ' +
                'title="这张只截了题目，点一下看整张原图">🖼 看原图</button>'
              : "") +
          "</span>" +
        "</div>" +
        "</div>";
    }

    html += '<div class="viewer__section">' +
      '<div class="viewer__label">题目</div>' +
      '<div class="viewer__content" data-math>' +
      (it.title ? escapeHtml(it.title) : '<span style="color:#4a6685">（没填题目）</span>') +
      "</div></div>";

    if (it.answer) {
      html += '<div class="viewer__section">' +
        '<div class="viewer__label">答案</div>' +
        '<div class="viewer__content viewer__content--answer" data-math>' +
        escapeHtml(it.answer) + "</div></div>";
    }

    if (it.note) {
      html += '<div class="viewer__section">' +
        '<div class="viewer__label">解析 / 错因</div>' +
        '<div class="viewer__content viewer__content--note" data-math>' +
        escapeHtml(it.note) + "</div></div>";
    }

    if ((it.tags || []).length) {
      html += '<div class="viewer__section">' +
        '<div class="viewer__label">标签</div>' +
        '<div class="card__tags">' + it.tags.map(function (t) {
          return '<span class="card__tag">' + escapeHtml(t) + "</span>";
        }).join("") + "</div></div>";
    }

    html += '<div class="viewer__section">' +
      '<div class="stat-hint">' + escapeHtml(it.subject || "其他") +
      " · 记于 " + fmtDate(it.createdAt) + "</div></div>";

    var body = $("viewerBody");
    body.innerHTML = html;
    body.querySelectorAll("[data-math]").forEach(renderMath);

    var tg = body.querySelector(".viewer__swap");
    if (tg) {
      tg.addEventListener("click", function () {
        var im = body.querySelector(".viewer__img");
        var v = state.viewerImg;
        if (!im || !v) return;

        var isFull = tg.dataset.mode === "full";
        im.src = isFull ? v.crop : v.full;
        tg.dataset.mode = isFull ? "crop" : "full";
        tg.textContent = isFull ? "🖼 看原图" : "📄 只看题目";
      });
    }

    var retake = body.querySelector(".viewer__retake");
    if (retake) {
      retake.addEventListener("click", function () {
        retakeImage(id, retake);
      });
    }

    $("viewer").classList.add("open");
    $("viewer").setAttribute("aria-hidden", "false");
  }

  // 只重截题目区域，不动题目 / 答案解析那些文字
  async function retakeImage(id, btn) {
    var it = state.items.find(function (x) { return x.id === id; });
    if (!it || !it.image) return;

    var key = getApiKey();
    if (!key) {
      toast("还没填 API Key，填了才能截题");
      return;
    }

    var old = btn.textContent;
    btn.disabled = true;
    btn.textContent = "截题中…";

    try {
      var cut = await makeQuestionCrop(it.image, key);

      if (!cut) throw new Error("这次没认出题目在哪块");

      it.imageCrop = cut;
      it.updatedAt = Date.now();

      await dbPut(it);
      await reload();
      openViewer(id);

      toast("重新截好了");
    } catch (err) {
      btn.disabled = false;
      btn.textContent = old;
      toast("截题失败：" + ((err && err.message) ? err.message : err));
    }
  }

  function closeViewer() {
    $("viewer").classList.remove("open");
    $("viewer").setAttribute("aria-hidden", "true");
    state.viewingId = null;
    state.viewerImg = null;
  }

  /* ---------------- 窄屏筛选面板 ---------------- */

  function isNarrow() {
    return window.matchMedia("(max-width: 860px)").matches;
  }

  // 窄屏时把搜索框搬进筛选抽屉里（顶栏放不下）
  function placeSearch() {
    var sw = document.querySelector(".search-wrap");
    var side = document.querySelector("#view-book .sidebar");
    var top = document.querySelector(".topbar");
    var tabs = $("tabs");
    if (!sw || !side || !top || !tabs) return;

    if (isNarrow()) {
      if (sw.parentNode !== side) side.insertBefore(sw, side.firstChild);
    } else if (sw.parentNode !== top) {
      top.insertBefore(sw, tabs.nextSibling);
    }
  }

  function setFilterPanel(open) {
    var side = document.querySelector("#view-book .sidebar");
    var mask = $("sideMask");
    if (!side || !mask) return;

    side.classList.toggle("is-open", !!open);
    mask.classList.toggle("is-open", !!open);
  }

  function toggleFilterPanel() {
    var side = document.querySelector("#view-book .sidebar");
    setFilterPanel(!(side && side.classList.contains("is-open")));
  }

  /* ---------------- 复习模式 ---------------- */

  // 第 n 次答对之后，隔几天再出现一次
  var REVIEW_DAYS = [0, 1, 3, 7, 15, 30];
  var REVIEW_MAX = 12;

  var rv = { queue: [], idx: 0, right: 0, wrong: 0 };

  function reviewOf(it) {
    var r = it.review || {};
    return {
      stage: Number(r.stage) || 0,
      dueAt: Number(r.dueAt) || 0,
      right: Number(r.right) || 0,
      wrong: Number(r.wrong) || 0,
      lastAt: Number(r.lastAt) || 0
    };
  }

  // 复习也按左边的学科 / 标签筛选走
  function reviewPool() {
    return state.items.filter(function (it) {
      if (state.filterSubject && (it.subject || "其他") !== state.filterSubject) return false;
      if (state.filterTag && (it.tags || []).indexOf(state.filterTag) === -1) return false;
      return true;
    });
  }

  function dueCount() {
    var now = Date.now();

    return reviewPool().filter(function (it) {
      var r = reviewOf(it);
      return !r.dueAt || r.dueAt <= now;
    }).length;
  }

  function updateReviewBadge() {
    var el = $("reviewBadge");
    if (!el) return;

    var n = dueCount();

    if (!state.items.length || !n) {
      el.hidden = true;
      return;
    }

    el.hidden = false;
    el.textContent = n > 99 ? "99+" : String(n);
  }

  function openReview(shuffle) {
    if (!state.items.length) {
      toast("还没有错题，先收几道再复习");
      return;
    }

    var now = Date.now();
    var pool = reviewPool();

    if (shuffle) {
      pool.sort(function () { return Math.random() - 0.5; });
    } else {
      pool = pool.filter(function (it) {
        var r = reviewOf(it);
        return !r.dueAt || r.dueAt <= now;
      });
      pool.sort(function (a, b) {
        var ra = reviewOf(a);
        var rb = reviewOf(b);
        // 没排过期的按加入时间排，别让新题永远排在最前面
        return (ra.dueAt || a.createdAt || 0) - (rb.dueAt || b.createdAt || 0);
      });
    }

    rv.queue = pool.slice(0, REVIEW_MAX);
    rv.idx = 0;
    rv.right = 0;
    rv.wrong = 0;

    $("review").classList.add("open");
    $("review").setAttribute("aria-hidden", "false");

    renderReview();
  }

  function closeReview() {
    $("review").classList.remove("open");
    $("review").setAttribute("aria-hidden", "true");

    renderSidebar();

    var s = loadSync();
    if (s.token && s.gistId) {
      try { syncNow(true); } catch (e) { /* 忽略 */ }
    }
  }

  function bindReviewFoot() {
    var sh = $("rvShuffle");
    if (sh) sh.addEventListener("click", function () { openReview(true); });

    var ag = $("rvAgain");
    if (ag) ag.addEventListener("click", function () { openReview(true); });

    var end = $("rvEnd");
    if (end) end.addEventListener("click", closeReview);
  }

  function renderReview() {
    var body = $("reviewBody");
    var foot = $("reviewFoot");
    var prog = $("reviewProg");

    // 今天没到期的
    if (!rv.queue.length) {
      prog.textContent = "";
      body.innerHTML = '<div class="review__blank">' +
        '<div class="review__blank-icon">🐟</div>' +
        "<h3>今天没有要复习的</h3>" +
        "<p>答对的题会按 1 / 3 / 7 / 15 / 30 天自己排期，到点了再来。</p>" +
        "</div>";
      foot.innerHTML =
        '<button type="button" class="btn btn--primary" id="rvShuffle">🎲 随便抽几道</button>' +
        '<button type="button" class="btn btn--ghost" id="rvEnd">先这样</button>';
      bindReviewFoot();
      return;
    }

    // 这轮过完了
    if (rv.idx >= rv.queue.length) {
      prog.textContent = "";
      body.innerHTML = '<div class="review__blank">' +
        '<div class="review__blank-icon">🎉</div>' +
        "<h3>这轮过完了</h3>" +
        '<p>会了 <b class="rv-ok">' + rv.right + "</b> 道 · 不会 <b class=\"rv-no\">" +
        rv.wrong + "</b> 道</p>" +
        "</div>";
      foot.innerHTML =
        '<button type="button" class="btn btn--primary" id="rvAgain">再来一轮</button>' +
        '<button type="button" class="btn btn--ghost" id="rvEnd">收工</button>';
      bindReviewFoot();
      return;
    }

    var it = rv.queue[rv.idx];
    var r = reviewOf(it);
    var img = it.imageCrop || it.image;
    var times = r.right + r.wrong;

    prog.textContent = "还剩 " + (rv.queue.length - rv.idx) + " 题";

    body.innerHTML = '<div class="review__card">' +
      '<div class="review__meta">' + escapeHtml(it.subject || "其他") +
      (times ? " · 复习过 " + times + " 次" : " · 还没复习过") + "</div>" +
      (img ? '<img class="review__img" src="' + img + '" alt="题目" loading="lazy" />' : "") +
      '<div class="review__q" data-math>' +
      (it.title ? escapeHtml(it.title) : '<span style="color:#4a6685">（这道没填题目）</span>') +
      "</div>" +
      '<div class="review__ans" id="rvAns" hidden>' +
      (it.answer
        ? '<div class="review__label">答案</div><div class="review__ansbox" data-math>' +
          escapeHtml(it.answer) + "</div>"
        : "") +
      (it.note
        ? '<div class="review__label">解析</div><div class="review__notebox" data-math>' +
          escapeHtml(it.note) + "</div>"
        : "") +
      (!it.answer && !it.note
        ? '<div class="stat-hint">这道当时没写答案和解析</div>'
        : "") +
      "</div>" +
      "</div>";

    body.querySelectorAll("[data-math]").forEach(renderMath);
    body.scrollTop = 0;

    foot.innerHTML =
      '<button type="button" class="btn btn--ghost" id="rvShow">👀 看答案</button>' +
      '<button type="button" class="btn btn--ghost" id="rvNo">❌ 不会</button>' +
      '<button type="button" class="btn btn--primary" id="rvYes">✅ 会了</button>';

    $("rvShow").addEventListener("click", function () {
      var ans = $("rvAns");
      if (!ans) return;
      ans.hidden = false;
      this.remove();
    });

    $("rvYes").addEventListener("click", function () { gradeReview(true); });
    $("rvNo").addEventListener("click", function () { gradeReview(false); });
  }

  async function gradeReview(ok) {
    var it = rv.queue[rv.idx];
    if (!it) return;

    var r = reviewOf(it);
    var now = Date.now();

    r.lastAt = now;

    if (ok) {
      r.right++;
      r.stage = Math.min(r.stage + 1, REVIEW_DAYS.length - 1);
      r.dueAt = now + REVIEW_DAYS[r.stage] * 86400000;
      rv.right++;
    } else {
      r.wrong++;
      r.stage = 0;
      r.dueAt = now + 86400000;
      rv.wrong++;
      rv.queue.push(it);   // 这轮最后再过一遍
    }

    it.review = r;
    it.updatedAt = now;

    try {
      await dbPut(it);
    } catch (e) {
      toast("这次没存上：" + e.message);
    }

    rv.idx++;
    renderReview();
  }

  /* ---------------- 导入导出 ---------------- */

  function exportJson() {
    if (!state.items.length) {
      toast("还没有数据可导出");
      return;
    }

    var data = JSON.stringify({
      app: "mistake-book",
      version: 1,
      exportedAt: new Date().toISOString(),
      items: state.items
    }, null, 2);

    var blob = new Blob([data], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    var d = new Date();
    a.href = url;
    a.download = "错题本备份-" +
      d.getFullYear() +
      String(d.getMonth() + 1).padStart(2, "0") +
      String(d.getDate()).padStart(2, "0") + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast("导出好了");
  }

  function importJson(file) {
    var reader = new FileReader();

    reader.onload = async function () {
      try {
        var data = JSON.parse(reader.result);
        var items = Array.isArray(data) ? data : data.items;

        if (!Array.isArray(items)) {
          toast("文件格式不对");
          return;
        }

        var count = 0;
        for (var i = 0; i < items.length; i++) {
          var it = items[i];
          if (!it || !it.id) continue;
          await dbPut(it);
          count++;
        }

        await reload();
        saveBase({});   // 灌进来的是外部数据，祖先对不上了
        toast("导入了 " + count + " 道");
      } catch (err) {
        toast("导入失败：文件读不懂");
      }
    };

    reader.readAsText(file);
  }

  /* ---------------- 数据加载 ---------------- */

  async function reload() {
    state.items = await dbGetAll();
    render();
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    // 学科下拉
    var sel = $("fSubject");
    sel.innerHTML = SUBJECTS.map(function (s) {
      return '<option value="' + s + '">' + s + "</option>";
    }).join("");

    // 新增 / 关闭
    $("btnNew").addEventListener("click", function () { openForm(null); });

    var emptyNew = $("emptyNew");
    if (emptyNew) emptyNew.addEventListener("click", function () { openForm(null); });
    $("btnClose").addEventListener("click", closeForm);
    $("btnCancel").addEventListener("click", closeForm);
    $("btnViewClose").addEventListener("click", closeViewer);

    // 窄屏筛选面板 / 复习
    var fb = $("btnFilter");
    if (fb) fb.addEventListener("click", function () { toggleFilterPanel(); });

    var mask = $("sideMask");
    if (mask) mask.addEventListener("click", function () { setFilterPanel(false); });

    var rb = $("btnReview");
    if (rb) rb.addEventListener("click", function () { openReview(false); });

    // 屏幕变宽了就把筛选面板收起来
    window.addEventListener("resize", function () {
      if (!isNarrow()) setFilterPanel(false);
      placeSearch();
    });

    $("reviewClose").addEventListener("click", closeReview);
    $("review").addEventListener("click", function (e) {
      if (e.target === $("review")) closeReview();
    });

    $("drawer").addEventListener("click", function (e) {
      if (e.target === $("drawer")) closeForm();
    });
    $("viewer").addEventListener("click", function (e) {
      if (e.target === $("viewer")) closeViewer();
    });

    // 表单提交
    $("form").addEventListener("submit", function (e) {
      saveForm(e).catch(function (err) {
        console.error(err);
        toast("保存失败：" + err.message);
      });
    });

    // 实时预览
    ["fTitle", "fAnswer", "fNote"].forEach(function (id) {
      $(id).addEventListener("input", updateFormPreview);
    });

    // 搜索
    $("search").addEventListener("input", function (e) {
      state.keyword = e.target.value.trim();
      renderList();
    });

    // 图片：点击
    $("drop").addEventListener("click", function (e) {
      if (e.target === $("fImage")) return;
      $("fImage").click();
    });

    $("fImage").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      if (f) handleImageFile(f);
      e.target.value = "";
    });

    // 图片：拖拽
    var drop = $("drop");
    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.remove("dragover");
      });
    });
    drop.addEventListener("drop", function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleImageFile(f);
    });

    // 图片：粘贴
    document.addEventListener("paste", function (e) {
      if (!$("drawer").classList.contains("open")) return;
      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          var f = items[i].getAsFile();
          if (f) {
            handleImageFile(f);
            e.preventDefault();
          }
          break;
        }
      }
    });

    // 自动识别
    $("btnOcr").addEventListener("click", recognizeImage);

    $("btnSetKey").addEventListener("click", askKey);
    $("btnKeyTop").addEventListener("click", askKey);

    // 余额面板
    var walletPop = $("walletPop");

    $("btnWallet").addEventListener("click", function (e) {
      e.stopPropagation();
      $("syncPop").hidden = true;
      walletPop.hidden = !walletPop.hidden;

      if (!walletPop.hidden) {
        updateWalletUI();

        var s = loadSpend();
        var inp = $("walletInput");
        inp.value = s.base == null ? "" : String(s.base);
        inp.focus();
      }
    });

    walletPop.addEventListener("click", function (e) { e.stopPropagation(); });

    document.addEventListener("click", function () {
      if (!walletPop.hidden) walletPop.hidden = true;
    });

    $("walletSave").addEventListener("click", function () {
      var v = parseFloat($("walletInput").value);

      if (isNaN(v) || v < 0) {
        toast("填个正常的数");
        return;
      }

      var s = loadSpend();
      s.base = v;
      s.baseAt = Date.now();
      s.spentSinceBase = 0;
      saveSpend(s);

      updateWalletUI();
      toast("记下了，还剩 " + fmtMoney(v));
    });

    $("walletReset").addEventListener("click", function () {
      if (!confirm("把累计花费和余额都清零？")) return;

      saveSpend({ spent: 0, base: null, baseAt: 0, spentSinceBase: 0 });
      $("walletInput").value = "";
      updateWalletUI();
      toast("清零了");
    });

    // 同步面板
    var syncPop = $("syncPop");

    $("btnSync").addEventListener("click", function (e) {
      e.stopPropagation();
      walletPop.hidden = true;
      syncPop.hidden = !syncPop.hidden;

      if (!syncPop.hidden) {
        updateSyncUI();
        setSyncStatus("");
      }
    });

    syncPop.addEventListener("click", function (e) { e.stopPropagation(); });

    document.addEventListener("click", function () {
      if (!syncPop.hidden) syncPop.hidden = true;
    });

    $("syncConnect").addEventListener("click", async function () {
      var t = $("syncToken").value.trim();

      if (!t) {
        setSyncStatus("先把 token 粘进来", "err");
        return;
      }

      saveSync({ token: t, gistId: "" });
      saveBase({});   // 换了账号就别拿旧祖先去合并了
      $("syncToken").value = "";
      updateSyncUI();
      await syncNow();
    });

    $("syncNow").addEventListener("click", function () { syncNow(); });

    $("syncOff").addEventListener("click", function () {
      if (!confirm("断开同步？本地数据不会删，只是以后不往云端传了。")) return;

      saveSync({ token: "", gistId: "" });
      saveBase({});
      updateSyncUI();
      setSyncStatus("已断开");
    });

    // 视图切换
    document.querySelectorAll("#tabs .tab").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.dataset.view); });
    });

    // 备忘录
    ["memoNew", "memoEmptyNew"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", function () { openMemo(null); });
    });

    var memoSearchEl = $("memoSearch");
    if (memoSearchEl) {
      memoSearchEl.addEventListener("input", function () {
        memoState.query = memoSearchEl.value || "";
        renderMemos();
      });
    }

    var memoFilterEl = $("memoFilter");
    if (memoFilterEl) {
      memoFilterEl.querySelectorAll(".memo-filter__tab").forEach(function (btn) {
        btn.addEventListener("click", function () {
          memoState.filter = btn.dataset.filter || "all";
          memoFilterEl.querySelectorAll(".memo-filter__tab").forEach(function (b) {
            b.classList.toggle("is-active", b === btn);
          });
          renderMemos();
        });
      });
    }

    ["memoClose", "memoCancel"].forEach(function (id) {
      var el = $(id);
      if (el) el.addEventListener("click", closeMemo);
    });

    var memoSaveEl = $("memoSave");
    if (memoSaveEl) memoSaveEl.addEventListener("click", saveMemo);

    var memoDeleteEl = $("memoDelete");
    if (memoDeleteEl) memoDeleteEl.addEventListener("click", deleteMemo);

    var whenNowEl = $("memoWhenNow");
    if (whenNowEl) whenNowEl.addEventListener("click", function () {
      $("memoWhen").value = toLocalInput(Date.now());
    });

    var whenClearEl = $("memoWhenClear");
    if (whenClearEl) whenClearEl.addEventListener("click", function () {
      $("memoWhen").value = "";
    });

    // 角色小贴纸：每次打开随机换几张
    (function rotateArt() {
      var pools = {
        xin: ["xin-01", "xin-02", "xin-03", "xin-04", "xin-05", "xin-06", "xin-07",
          "xin-08", "xin-09", "xin-10", "xin-11", "xin-12", "xin-13", "xin-14"],
        qx: ["qx-wow", "qx-thumb", "qx-melon", "qx-fist", "qx-open", "qx-rose",
          "qx-pinch", "qx-sweat", "qx-peek", "qx-chin", "qx-phone", "qx-front",
          "qx-think", "qx-rain"],
        lili: ["lili-heart", "lili-melon", "lili-nose", "lili-peace", "lili-pot"]
      };

      Object.keys(pools).forEach(function (key) {
        var pool = pools[key].slice();
        for (var i = pool.length - 1; i > 0; i--) {
          var j = Math.floor(Math.random() * (i + 1));
          var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
        }
        document.querySelectorAll('img[data-pick="' + key + '"]').forEach(function (img, idx) {
          img.src = "assets/" + pool[idx % pool.length] + ".webp";
          img.removeAttribute("data-pick");
        });
      });
    })();

    // 竖版立绘轮换：淡出 → 换图 → 淡入
    (function rotatePortrait() {
      var LISTS = {
        xin: ["xin-art1", "xin-art2", "xin-art3", "xin-art4"],
        qx: ["qx-key", "qx-sweater", "qx-ice", "qx-sunset", "qx-beach"],
        lili: ["lili-key", "lili-forest", "lili-water", "lili-swirl",
          "lili-film", "lili-dark", "lili-shop"]
      };

      document.querySelectorAll("img[data-rot]").forEach(function (img, idx) {
        var list = LISTS[img.dataset.rot];
        if (!list || list.length < 2) return;
        img.removeAttribute("data-rot");

        // 预热，换的时候不闪
        list.forEach(function (n) { new Image().src = "assets/" + n + ".webp"; });

        var cur = Math.floor(Math.random() * list.length);
        img.src = "assets/" + list[cur] + ".webp";

        var busy = false;
        setInterval(function () {
          if (busy || document.hidden) return;
          if (img.offsetParent === null) return; // 页面没在显示就跳过
          busy = true;
          cur = (cur + 1) % list.length;
          img.classList.add("is-rot-out");
          setTimeout(function () {
            img.src = "assets/" + list[cur] + ".webp";
            setTimeout(function () {
              img.classList.remove("is-rot-out");
              busy = false;
            }, 80);
          }, 320);
        }, 7000 + idx * 600);
      });
    })();

    var memoDrawerEl = $("memoDrawer");
    if (memoDrawerEl) {
      memoDrawerEl.addEventListener("click", function (e) {
        if (e.target === memoDrawerEl) closeMemo();
      });
    }

    // 总结：选图（input 在容器里，要挡一下别让点击冒泡回容器造成死循环）
    $("sumDrop").addEventListener("click", function (e) {
      if (e.target === $("sumImage")) return;
      $("sumImage").click();
    });

    $("sumImage").addEventListener("change", function (e) {
      addFiles(e.target.files);
      e.target.value = "";
    });

    // 总结：拖拽
    var sumDrop = $("sumDrop");
    ["dragenter", "dragover"].forEach(function (ev) {
      sumDrop.addEventListener(ev, function (e) {
        e.preventDefault();
        sumDrop.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      sumDrop.addEventListener(ev, function (e) {
        e.preventDefault();
        sumDrop.classList.remove("dragover");
      });
    });
    sumDrop.addEventListener("drop", function (e) {
      if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
    });

    // 导入文档：按钮开文件框，选完统一进门
    $("sumDoc").addEventListener("click", function () {
      $("sumDocInput").click();
    });

    $("sumDocInput").addEventListener("change", function (e) {
      if (e.target.files && e.target.files.length) addFiles(e.target.files);
      e.target.value = "";
    });

    // 文档分节粒度：每页 / 每章 / 整份
    var granEl = $("sumGran");
    if (granEl) {
      granEl.value = sum.gran;

      granEl.addEventListener("change", function () {
        var v = granEl.value;

        if (sum.busy) {
          granEl.value = sum.gran;
          toast("正在跑，跑完再换分节方式");
          return;
        }

        if ((sum.sections.length || sum.done.length) && !resetProgressIfNeeded("分节方式")) {
          granEl.value = sum.gran;
          return;
        }

        sum.gran = v;

        var txt = granEl.options[granEl.selectedIndex].text;
        var hint = v === "page"
          ? "一页一节，逐页总结"
          : v === "chapter"
            ? "认出「第 X 章」就按章合一节，认不出来按每 6 页一节"
            : "整份合成一大段总结，内容多会写长（必要时分几块）";

        sumStatus("分节改成「" + txt + "」：" + hint + "。点「开始总结」开跑", "ok");
      });
    }

    // 总结：粘贴
    document.addEventListener("paste", function (e) {
      if (state.view !== "summary") return;

      var items = e.clipboardData && e.clipboardData.items;
      if (!items) return;

      var files = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image/") === 0) {
          var f = items[i].getAsFile();
          if (f) files.push(f);
        }
      }

      if (files.length) {
        addImages(files);
        e.preventDefault();
      }
    });

    // 总结：跑 / 清空
    $("sumRun").addEventListener("click", function () {
      if (sum.busy) return;

      // 有没跑完的草稿：问一句接着跑还是重头来
      var d = sum.draft;
      var left = d ? (d.total || 0) - (d.done || []).length : 0;

      if (d && left > 0) {
        var goOn = confirm("上次还有 " + left + " 段没跑完。\n\n点「确定」接着跑剩下的\n点「取消」从头重新跑一遍");

        if (goOn) {
          resumeDraft().catch(function (err) { toast("接着跑失败：" + err.message); });
        } else {
          clearDraft();
          refreshDraftBar();
          sum.sections = [];
          sum.failed = [];
          sum.done = [];
          runSummary();
        }
        return;
      }

      runSummary();
    });

    $("sumSave").addEventListener("click", function () {
      saveCurrentSummary().catch(function (err) {
        toast("保存失败：" + err.message);
      });
    });

    $("sumToBook").addEventListener("click", function () {
      toMistakeBook().catch(function (err) {
        toast("存错题失败：" + err.message);
      });
    });

    $("sumCopy").addEventListener("click", function () {
      if (sum.current) copyText(buildPlainText(sum.current));
    });

    // 多选 / 导出
    $("sumSelectAll").addEventListener("click", function () {
      var all = sum.saved.length;
      var n = pickedIds().length;

      sum.selected = {};

      if (n !== all) {
        sum.saved.forEach(function (s) { sum.selected[s.id] = 1; });
      }

      renderSavedList();
    });

    $("sumExport").addEventListener("click", exportPdf);

    $("sumClear").addEventListener("click", function () {
      sum.images = [];
      sum.thumbs = [];
      sum.texts = [];
      sum.hashes = {};
      sum.sections = [];
      sum.failed = [];
      sum.done = [];
      sum.current = null;
      sum.currentId = null;
      sum.editing = false;
      sum.draft = null;

      clearDraft();

      renderThumbs();
      $("sumResult").hidden = true;
      $("sumEmpty").hidden = false;
      $("sumToolbar").hidden = true;
      if ($("sumRetry")) $("sumRetry").hidden = true;
      sumStatus("");
      updateSaveBtn();
      renderSavedList();
      refreshDraftBar();
    });

    // 停下 / 接着跑 / 不要草稿了 / 重跑失败的 / 改字
    $("sumStop").addEventListener("click", function () {
      if (!sum.busy && !sum.reading) return;

      sum.stop = true;
      $("sumStop").disabled = true;
      sumStatus(sum.reading ? "读完这一页就停…" : "正在收尾，把手上这张跑完就停…");
    });

    $("sumResume").addEventListener("click", function () {
      if (!sum.draft) return;
      resumeDraft().catch(function (err) { toast("接着跑失败：" + err.message); });
    });

    $("sumGiveUp").addEventListener("click", function () {
      if (!confirm("这份草稿不要了？已经跑出来的段落也没了")) return;

      sum.draft = null;
      sum.sections = [];
      sum.failed = [];
      sum.done = [];
      sum.images = [];
      sum.thumbs = [];
      sum.texts = [];
      sum.hashes = {};
      sum.current = null;
      sum.currentId = null;

      clearDraft();
      refreshDraftBar();
      renderThumbs();
      $("sumResult").hidden = true;
      $("sumEmpty").hidden = false;
      $("sumToolbar").hidden = true;
      sumStatus("草稿扔了");
    });

    $("sumRetry").addEventListener("click", function () {
      if (sum.busy || !sum.failed.length) return;
      var again = sum.failed.slice();
      sumStatus("重跑 " + again.length + " 段…");
      runSummary({ only: again }).catch(function (err) { toast("重跑失败：" + err.message); });
    });

    $("sumEdit").addEventListener("click", toggleEditSummary);

    // 总结搜索
    $("sumSearch").addEventListener("input", function (e) {
      sum.query = e.target.value || "";
      renderSavedList();
    });

    // 存储占用：点一下重新算
    $("statStore").addEventListener("click", function () {
      var el = $("storeSize");
      if (el) el.textContent = "算一下…";
      updateStoreSize();
    });

    // 移除图片
    $("btnClearImage").addEventListener("click", function () {
      state.editingImage = "";
      state.editingCrop = "";
      $("preview").src = "";
      $("preview").hidden = true;
      $("dropHint").style.display = "flex";
      $("btnClearImage").hidden = true;
    });

    // 导出导入
    $("btnExport").addEventListener("click", exportJson);

    $("btnImport").addEventListener("click", function () {
      var input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.onchange = function () {
        if (input.files && input.files[0]) importJson(input.files[0]);
      };
      input.click();
    });

    // 查看器：编辑 / 删除
    $("btnViewEdit").addEventListener("click", function () {
      var it = state.items.find(function (x) { return x.id === state.viewingId; });
      if (!it) return;
      closeViewer();
      openForm(it);
    });

    $("btnViewDelete").addEventListener("click", async function () {
      var it = state.items.find(function (x) { return x.id === state.viewingId; });
      if (!it) return;

      var snapshot = Object.assign({}, it);

      await dbDelete(it.id);
      markDeleted(it.id);
      closeViewer();
      await reload();

      toast("删掉了这道", "撤销", async function () {
        unmarkDeleted(snapshot.id);
        await dbPut(snapshot);
        await reload();
        toast("回来了");
      });

      syncSoon(7000);
    });

    // 快捷键
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        if ($("drawer").classList.contains("open")) closeForm();
        if ($("viewer").classList.contains("open")) closeViewer();
      }
      // Ctrl+N 新增
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        if (!$("drawer").classList.contains("open")) openForm(null);
      }
    });
  }

  /* ---------------- 智谱 GLM-OCR ---------------- */

  var OCR_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/layout_parsing";
  var KEY_STORAGE = "mistake-book.zhipu-key";

  function getApiKey() {
    try { return (localStorage.getItem(KEY_STORAGE) || "").trim(); }
    catch (e) { return ""; }
  }

  function setApiKey(k) {
    try {
      if (k) localStorage.setItem(KEY_STORAGE, k);
      else localStorage.removeItem(KEY_STORAGE);
    } catch (e) { /* 忽略 */ }
  }

  function setOcrStatus(msg, type) {
    var el = $("ocrStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "ocr-status" + (type ? " " + type : "");
  }

  function updateOcrHint() {
    var btn = $("btnSetKey");
    if (btn) btn.textContent = getApiKey() ? "🔑 Key 已设置" : "🔑 Key";

    var top = $("btnKeyTop");
    if (top) {
      top.title = getApiKey()
        ? "API Key 已设置，点这里可以修改"
        : "还没填 API Key，点这里填";
      // 手机上「未设置」三个字会把顶栏挤爆，窄屏只留图标
      top.innerHTML = getApiKey() ? "🔑" : '🔑<span class="hide-narrow"> 未设置</span>';
    }
  }

  function askKey() {
    var k = prompt(
      "粘贴你的智谱 API Key\n（open.bigmodel.cn → API Keys）\n\n留空则清除已保存的 Key：",
      ""
    );
    if (k === null) return;
    setApiKey(k.trim());
    toast(k.trim() ? "Key 已保存" : "Key 已清除");
    updateOcrHint();
  }

  // 单张图 → 文字（OCR 和总结两边共用）
  async function ocrOne(dataUrl, key) {
    var resp = await fetch(OCR_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key
      },
      body: JSON.stringify({ model: "glm-ocr", file: dataUrl })
    });

    var raw = await resp.text();

    if (!resp.ok) {
      throw new Error("识别接口返回 " + resp.status + "：" + raw.slice(0, 200));
    }

    var data = JSON.parse(raw);
    var md = String(data.md_results || "").trim();

    if (!md) throw new Error("这张图没认出内容，可能太模糊了");

    recordOcrCost(data.usage);

    return md;
  }

  // 往表单框里填：force=true 时题目框按「覆盖 / 追加」问一句，false 时只填空框
  function putField(id, value, force) {
    var v = String(value == null ? "" : value).trim();
    if (!v) return false;

    var el = $(id);
    if (!el) return false;

    if (!force) {
      if (el.value.trim()) return false;
      el.value = v;
      return true;
    }

    if (el.value.trim() && !confirm("题目框已经有内容，用识别结果覆盖吗？\n点「取消」会把结果追加在后面")) {
      el.value = el.value.trim() + "\n\n" + v;
    } else {
      el.value = v;
    }
    return true;
  }

  /* ---------------- 自动截题：只留题干，别一眼扫到解析 ---------------- */

  var CUT_MODEL = "glm-4.5v";

  var CUT_PROMPT = [
    "这是数学/理科的课件、作业或试卷截图。图里一般先是题目（题干），后面紧跟着证明、解析、答案。",
    "请判断：题干的最后一行，在整张图的高度方向上大概到什么比例结束？也就是从哪一行开始就已经是解析/答案了。",
    "只输出一个 0 到 1 之间的小数（两位），表示那条分界线占整张图高度的比例，不要输出别的字。",
    "例子：题干只占最上面一行、下面全是证明 → 0.13；题干占上面三成 → 0.30。",
    "如果整张图都是题目、压根没有解析，就输出 1。"
  ].join("\n");

  function loadImage(src) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("图片读不出来")); };
      img.src = src;
    });
  }

  // 让视觉模型估一条「解析从这儿开始」的分界线
  async function askCutRatio(dataUrl, key) {
    var resp = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key
      },
      body: JSON.stringify({
        model: CUT_MODEL,
        thinking: { type: "disabled" },
        temperature: 0.1,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: CUT_PROMPT }
          ]
        }]
      })
    });

    var raw = await resp.text();

    if (!resp.ok) throw new Error("截题接口 " + resp.status + "：" + raw.slice(0, 120));

    var data = JSON.parse(raw);
    recordChatCost(CUT_MODEL, data.usage);

    var msg = data.choices && data.choices[0] && data.choices[0].message;
    var txt = String((msg && msg.content) || "");
    var m = txt.match(/\d+(?:\.\d+)?/);

    if (!m) return 0;

    var r = parseFloat(m[0]);
    if (r > 1) r = r / 100;   // 万一回了 13 这种百分比

    // 太靠上/太靠下都不可信，宁可不截
    return r > 0.04 && r < 0.92 ? r : 0;
  }

  // 把图缩成一条条「每行有多少墨」，用来找行与行之间的缝
  // 亮底黑字、暗底白字都吃得下：先统计出现最多的那个亮度当背景
  function inkProfile(img) {
    var W = 620;
    var H = Math.round(W * img.naturalHeight / Math.max(1, img.naturalWidth));

    if (H > 1500) {
      W = Math.round(W * 1500 / H);
      H = 1500;
    }

    H = Math.max(1, H);

    var cv = document.createElement("canvas");
    cv.width = W;
    cv.height = H;

    var ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, W, H);

    var d;
    try {
      d = ctx.getImageData(0, 0, W, H).data;
    } catch (e) {
      return null;   // 跨域那种读不了的，直接放弃
    }

    var lum = new Uint8Array(W * H);
    var hist = new Array(16);
    var i, x, y, p, v;

    for (i = 0; i < 16; i++) hist[i] = 0;

    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        p = (y * W + x) * 4;
        v = (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) | 0;
        lum[y * W + x] = v;
        hist[v >> 4]++;
      }
    }

    var bg = 128;
    var most = -1;

    for (i = 0; i < 16; i++) {
      if (hist[i] > most) { most = hist[i]; bg = i * 16 + 8; }
    }

    var rows = new Array(H);

    for (y = 0; y < H; y++) {
      var n = 0;
      var base = y * W;

      for (x = 0; x < W; x++) {
        if (Math.abs(lum[base + x] - bg) > 60) n++;
      }

      rows[y] = n / W;
    }

    return { rows: rows, h: H };
  }

  // 模型给的是「大概」，这里把它吸到真正的空白行上，免得把一行字拦腰切了
  function detectCutFrame(img, ratio) {
    var prof = inkProfile(img);
    if (!prof) return { top: 0, bottom: ratio };

    var rows = prof.rows;
    var H = prof.h;
    var THR = 0.012;

    var y, firstInk = -1;

    for (y = 0; y < H; y++) {
      if (rows[y] >= THR) { firstInk = y; break; }
    }

    if (firstInk < 0) return null;

    // 所有空白带
    var gaps = [];
    var run = -1;

    for (y = 0; y <= H; y++) {
      var blank = y < H ? rows[y] < THR : true;

      if (blank) {
        if (run < 0) run = y;
      } else if (run >= 0) {
        gaps.push([run, y]);
        run = -1;
      }
    }

    var target = ratio * H;
    var best = null;
    var bestD = 1e9;
    var i, g, mid, gapY;

    for (i = 0; i < gaps.length; i++) {
      g = gaps[i];
      gapY = g[1] - g[0];

      if (gapY < 2) continue;          // 缝太细，多半是公式里的小空隙
      if (g[0] <= firstInk) continue;  // 不能切在正文上头

      mid = (g[0] + g[1]) / 2;

      if (Math.abs(mid - target) < bestD) {
        bestD = Math.abs(mid - target);
        best = g;
      }
    }

    var cutY;

    if (best && bestD <= H * 0.09) {
      cutY = cleanCut(rows, best[0], H) / H;
    } else {
      cutY = ratio;
    }

    var topY = Math.max(0, (firstInk - 2) / H);

    if (cutY - topY < 0.04) return null;   // 截出来还没一行高，算了

    return { top: topY, bottom: cutY };
  }

  // 缝底下常挂着一点笔画尾巴（比如分数下面那半截 2），
  // 一路探到下一行的字真出现之前再下刀，尾巴就不会被切掉
  function cleanCut(rows, gapStart, H) {
    var STRONG = 0.02;    // 一行字该有的墨量
    var MAX_LOOK = 24;    // 最多往下看这么多行（profile 行，约半行字高）
    var stop = Math.min(H - 1, gapStart + MAX_LOOK);
    var y;

    for (y = gapStart; y <= stop; y++) {
      if (rows[y] >= STRONG) {
        return Math.max(gapStart + 1, y - 2);   // 退两行，躲开下一行字的抗锯齿
      }
    }

    return stop;
  }

  function cropByFrame(img, frame) {
    var W = img.naturalWidth;
    var H = img.naturalHeight;
    var top = Math.round(frame.top * H);
    var bot = Math.round(frame.bottom * H);
    var h = bot - top;

    if (h < 24) return "";

    var outW = Math.min(W, 1400);
    var scale = outW / W;

    var cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(outW));
    cv.height = Math.max(1, Math.round(h * scale));

    var ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, top, W, h, 0, 0, cv.width, cv.height);

    var out = cv.toDataURL("image/webp", 0.86);
    if (!/^data:image\/webp/.test(out)) out = cv.toDataURL("image/jpeg", 0.88);

    return out;
  }

  async function makeQuestionCrop(dataUrl, key) {
    var ratio = await askCutRatio(dataUrl, key);
    if (!ratio) return "";

    var img = await loadImage(dataUrl);
    var frame = detectCutFrame(img, ratio);
    if (!frame) return "";

    return cropByFrame(img, frame);
  }

  // 等太久就先用空结果走人，别把识别卡在这儿
  function withTimeout(promise, ms, fallback) {
    return new Promise(function (resolve) {
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        resolve(fallback);
      }, ms);

      function settle(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      }

      promise.then(settle, function () { settle(fallback); });
    });
  }

  async function recognizeImage() {
    var key = getApiKey();

    if (!key) {
      setOcrStatus("还没填 API Key，点旁边那个「🔑 Key」填一下", "err");
      return;
    }

    if (!state.editingImage) {
      setOcrStatus("先放一张图进来再识别", "err");
      return;
    }

    var btn = $("btnOcr");
    btn.disabled = true;
    setOcrStatus("正在识别…整页的可能要等几秒");

    var src = state.editingImage;

    // 顺手让视觉模型把题干那块截出来（和 OCR 同时跑，不额外等）
    var cropPromise = makeQuestionCrop(src, key).catch(function () { return ""; });

    try {
      var md = await ocrOne(src, key);

      // 第二道：让模型把整页拆成 题目 / 答案 / 解析
      var parts = null;
      setOcrStatus("认完了，正在拆题目 / 答案 / 解析…");
      try {
        parts = await chatSplit(md, key);
      } catch (e) {
        parts = null;
      }

      var cropped = "";
      try {
        cropped = await withTimeout(cropPromise, 15000, "");
      } catch (e) {
        cropped = "";
      }

      if (cropped && state.editingImage === src) state.editingCrop = cropped;

      var cutNote = cropped ? " · 已把题目截出来，点开看题只显示题干" : "";

      var filled = [];
      if (parts) {
        var filledTitle = putField("fTitle", parts.question, true);
        var filledAns = putField("fAnswer", parts.answer, false);
        var filledNote = putField("fNote", parts.analysis, false);
        if (filledTitle) filled.push("题目");
        if (filledAns) filled.push("答案");
        if (filledNote) filled.push("解析");
      }

      if (!parts || !filled.length) {
        // 拆不动就退回老样子：整段塞题目
        var t = $("fTitle");
        if (t.value.trim() && !confirm("题目框已经有内容，用识别结果覆盖吗？\n点「取消」会把结果追加在后面")) {
          t.value = t.value.trim() + "\n\n" + md;
        } else {
          t.value = md;
        }
        updateFormPreview();
        setOcrStatus("识别完了（没拆开，整段放进题目了），不对可以手改" + cutNote, "ok");
        return;
      }

      updateFormPreview();

      var skip = [];
      if (!filledAns && parts.answer) skip.push("答案");
      if (!filledNote && parts.analysis) skip.push("解析");

      var note = "拆好了：" + filled.join("、");
      if (skip.length) note += "（" + skip.join("、") + " 框里本来有字，没动）";
      if (!parts.answer) note += " · 原文没找到独立答案";

      setOcrStatus(note + cutNote + "。不对可以手改", "ok");
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);

      if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
        msg = "请求发不出去（多半是浏览器跨域限制）。这个接口可能不允许网页直连，得加一层代理转发。";
      }

      setOcrStatus("识别失败：" + msg, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function handleImageFile(file) {
    compressImage(file).then(function (dataUrl) {
      state.editingImage = dataUrl;
      state.editingCrop = "";   // 换了图，之前那道题的截图就不算数了
      $("preview").src = dataUrl;
      $("preview").hidden = false;
      $("dropHint").style.display = "none";
      $("btnClearImage").hidden = false;
      toast("图片已就位，可以先不用管它");
    }).catch(function (err) {
      toast("图片处理失败：" + err.message);
    });
  }

  /* ---------------- 图片总结 ---------------- */

  // 注意结尾这个斜杠：智谱这个网关只有 /chat/completions/ 带斜杠的路径
  // 才会返回 Access-Control-Allow-Origin，不带斜杠浏览器会直接拦掉。
  var CHAT_ENDPOINT = "https://open.bigmodel.cn/api/paas/v4/chat/completions/";

  // 先用新的（聪明，慢一点），挂了再退到老的（快，简陋）
  var CHAT_MODELS = ["glm-5.3-flash", "glm-4-flash"];
  var MAX_IMAGES = 50;

  var SUMMARY_SYSTEM = [
    "你是学习助手。用户会给你一段从课件、课本或课堂截图里 OCR 出来的文字，里面可能夹着 LaTeX 公式。",
    "请读懂它，然后只输出一个 JSON 对象，不要写任何解释，不要加 ```json 围栏。JSON 结构是：",
    "{",
    '  "title": "这部分讲什么，12 个字以内",',
    '  "summary": "两三句话概括讲了什么",',
    '  "points": ["核心知识点，每条一句话", "..."],',
    '  "formulas": ["关键公式的 LaTeX 源码", "..."],',
    '  "quiz": [{"q": "自测题", "a": "答案和解析，两三句话"}]',
    "}",
    "要求：",
    "1. points 给 3~8 条，抓重点，不要照抄原文；",
    "2. formulas 给 0~8 条，每条必须是能直接编译的 LaTeX 源码（例如 \\frac{f(b)-f(a)}{b-a}），绝对不要写成「罗尔定理公式」这种中文描述；原文里没有公式就给空数组；",
    "3. quiz 给 1~3 条，要考上面讲的知识点；",
    "4. points 和 quiz 的文字里如果要写公式，必须用 $ 包起来（例如 得到 $f'(\\xi)=0$），绝对不要写裸的 \\frac{}{}；",
    "5. 全部用中文；",
    "6. 如果上面标着【第 1 张】【第 2 张】…好多张，那是同一节课连续的课件，要把每张都读进来、按顺序覆盖全部内容，绝对不能只总结第一张；",
    "7. 如果内容明显不是学习相关（闲聊、广告、纯装饰），title 写「不是学习内容」，summary 说明一下，其余字段给空数组。"
  ].join("\n");

  // 按章 / 整份一起总结时用这一套：允许写长，别硬压成一页
  var SUMMARY_SYSTEM_LONG = [
    "你是学习助手。用户会给你一段从课本或课件里 OCR 出来的文字，可能横跨很多页，里面夹着 LaTeX 公式。",
    "请读懂它，然后只输出一个 JSON 对象，不要写任何解释，不要加 ```json 围栏。JSON 结构是：",
    "{",
    '  "title": "这一段讲什么，20 个字以内",',
    '  "summary": "这段的整体脉络，三四句话，说清从哪讲到哪",',
    '  "points": ["核心知识点，每条一句话", "..."],',
    '  "formulas": ["关键公式的 LaTeX 源码", "..."],',
    '  "quiz": [{"q": "自测题", "a": "答案和解析，两三句话"}]',
    "}",
    "要求：",
    "1. 内容多就写长，**不要为了压成一页而丢东西**；points 给 6~15 条，把这一段的定义、定理、推导思路、例题类型都覆盖到；",
    "2. formulas 给 0~15 条，每条必须是能直接编译的 LaTeX 源码（例如 \\frac{f(b)-f(a)}{b-a}），不要写中文描述；原文没有公式就给空数组；",
    "3. quiz 给 1~4 条，考上面讲的知识点；",
    "4. points 和 quiz 里的公式必须用 $ 包起来（例如 得到 $f'(\\xi)=0$），不要写裸的 \\frac{}{}；",
    "5. 全部用中文；",
    "6. 如果原文里出现「第 X 章 / 第 X 节」这类标题，保留在 title 或 points 里，方便对回原书；",
    "7. 如果内容明显不是学习相关（闲聊、广告、纯装饰），title 写「不是学习内容」，summary 说明一下，其余字段给空数组。"
  ].join("\n");

  var sum = {
    images: [],
    thumbs: [],     // 和 images 一一对应的小图，同步用
    texts: [],      // 从文档里抽出来的文字段（{label, text}），不用走 OCR
    hashes: {},     // 指纹，防同一张图放两遍
    docImgs: {},    // 哪些图是文档里的「扫描页」（按 images 的下标记）
    pageText: {},   // 扫描页识别出来的文字缓存，按章/整份合并时要先用它
    gran: "page",   // 文档分节粒度：page / chapter / whole
    busy: false,
    stop: false,
    reading: false, // 正在解 PDF，这时候停下只停读
    sections: [],   // 每张图各自那段结果（带 idx）
    failed: [],     // 没读出来的下标
    done: [],       // 跑完了的下标（成功+失败）
    draft: null,    // 从库里捞出来的草稿
    current: null,
    currentId: null,
    saved: [],
    selected: {},
    query: "",
    editing: false
  };

  function sumStatus(msg, type) {
    var el = $("sumStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "ocr-status" + (type ? " " + type : "");
  }

  // 换了图以后，把「哪些图已经在里面」重算一遍
  function rehashImages() {
    sum.hashes = {};
    sum.images.forEach(function (src) { sum.hashes[hashOf(src)] = 1; });
  }

  function renderThumbs() {
    var box = $("sumThumbs");
    var html = sum.images.map(function (src, i) {
      return '<div class="sum-thumb"><img src="' + src + '" alt="" />' +
        '<button type="button" class="sum-thumb__del" data-kind="img" data-i="' + i + '" title="移除">✕</button></div>';
    }).join("");

    html += sum.texts.map(function (t, i) {
      return '<div class="sum-thumb sum-thumb--doc" title="' + escapeHtml(t.label || "") + '">' +
        '<span class="sum-thumb__doc">📄</span>' +
        '<span class="sum-thumb__name">' + escapeHtml(t.label || "文档") + "</span>" +
        '<button type="button" class="sum-thumb__del" data-kind="txt" data-i="' + i + '" title="移除">✕</button></div>';
    }).join("");

    box.innerHTML = html;

    box.querySelectorAll(".sum-thumb__del").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();

        if (sum.busy) {
          toast("正在跑，先停下再删");
          return;
        }

        var i = Number(b.dataset.i);

        // 删东西会让后面的编号整体前移，已经跑出来的段就对不上了，干脆重来
        if (sum.sections.length || sum.draft) {
          if (!confirm("删掉这份以后，已经跑出来的会重排，进度就乱了。\n\n要清掉进度重新来吗？")) return;

          sum.sections = [];
          sum.failed = [];
          sum.done = [];
          sum.current = null;
          clearDraft();
          refreshDraftBar();
          $("sumResult").hidden = true;
          $("sumEmpty").hidden = false;
          $("sumToolbar").hidden = true;
        }

        if (b.dataset.kind === "txt") {
          sum.texts.splice(i, 1);
        } else {
          sum.images.splice(i, 1);
          sum.thumbs.splice(i, 1);
          rehashImages();
        }

        renderThumbs();
        if (sum.sections.length || sum.draft) refreshDraftBar();
      });
    });

    var drop = $("sumDrop");
    if (drop) drop.classList.toggle("has-images", sum.images.length + sum.texts.length > 0);
  }

  // 往队列里加东西之前：已经跑出来的段是按编号对位的，加了新的就会错位
  function resetProgressIfNeeded(what) {
    if (!sum.sections.length && !sum.done.length && !sum.draft) return true;

    if (sum.busy) {
      toast("正在跑，等它跑完再加");
      return false;
    }

    if (!confirm("加" + (what || "新内容") + "会把之前跑出来的进度清掉（内容还在）。\n\n继续吗？")) {
      return false;
    }

    sum.sections = [];
    sum.failed = [];
    sum.done = [];
    sum.current = null;
    sum.currentId = null;
    clearDraft();
    refreshDraftBar();
    $("sumResult").hidden = true;
    $("sumResult").innerHTML = "";
    $("sumEmpty").hidden = false;
    $("sumToolbar").hidden = true;
    if ($("sumRetry")) $("sumRetry").hidden = true;
    updateSaveBtn();
    sumStatus("加了新内容，进度重置了，点「开始总结」重跑");

    return true;
  }

  function addImages(files) {
    var list = Array.prototype.slice.call(files || []).filter(function (f) {
      return f && f.type && f.type.indexOf("image/") === 0;
    });

    if (!list.length) return;

    var room = MAX_IMAGES - sum.images.length;
    if (room <= 0) {
      toast("最多 " + MAX_IMAGES + " 张，先删几张吧");
      return;
    }
    if (list.length > room) {
      toast("最多 " + MAX_IMAGES + " 张，多出来的先不放");
      list = list.slice(0, room);
    }

    Promise.all(list.map(function (f) {
      return compressImage(f).then(function (url) {
        return thumbOf(url).then(function (th) {
          return { url: url, thumb: th, hash: hashOf(url) };
        });
      });
    })).then(function (made) {
      // 先去重：全是重复的就没必要清进度
      var fresh = made.filter(function (m) { return !sum.hashes[m.hash]; });
      var dup = made.length - fresh.length;

      if (!fresh.length) {
        toast("这几张都在里面了，没重复放");
        return;
      }

      if (!resetProgressIfNeeded("图片")) return;

      fresh.forEach(function (m) {
        sum.hashes[m.hash] = 1;
        sum.images.push(m.url);
        sum.thumbs.push(m.thumb);
      });

      renderThumbs();

      sumStatus("放了 " + sum.images.length + " 张，点「开始总结」" +
        (dup ? "（跳过 " + dup + " 张重复的）" : ""));
    }).catch(function (err) {
      toast("图片处理失败：" + err.message);
    });
  }

  // 模型给 LaTeX 时经常不按 JSON 规范转义：\frac 里的 \f 会被 JSON 当成换页符吃掉，
  // \xi 又直接是非法转义。这里在解析前把字符串里的"单反斜杠"统一补成"双反斜杠"，
  // 已经成对的 \\、转义引号 \" 和 \uXXXX 原样保留。
  function repairJson(text) {
    var out = "";
    var inStr = false;

    for (var i = 0; i < text.length; i++) {
      var c = text.charAt(i);

      if (!inStr) {
        if (c === '"') inStr = true;
        out += c;
        continue;
      }

      if (c === '"') {
        inStr = false;
        out += c;
        continue;
      }

      if (c === "\\") {
        var n = text.charAt(i + 1);

        if (n === "") {
          out += "\\\\";
          break;
        }
        if (n === "\\") {
          out += "\\\\";
          i++;
          continue;
        }
        if (n === '"') {
          out += '\\"';
          i++;
          continue;
        }
        if (n === "u" && /^[0-9a-fA-F]{4}$/.test(text.substr(i + 2, 4))) {
          out += "\\u" + text.substr(i + 2, 4);
          i += 5;
          continue;
        }

        out += "\\\\" + n;
        i++;
        continue;
      }

      out += c;
    }

    return out;
  }

  function parseJsonLoose(s) {
    var t = String(s || "").trim();
    t = t.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();

    var i = t.indexOf("{");
    var j = t.lastIndexOf("}");
    if (i >= 0 && j > i) t = t.slice(i, j + 1);

    try {
      return JSON.parse(repairJson(t));
    } catch (e) {
      throw new Error("模型返回的不是能读的 JSON");
    }
  }

  async function chatOnce(model, text, key, sysPrompt, maxTokens) {
    var resp = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": key
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: "system", content: sysPrompt || SUMMARY_SYSTEM },
          { role: "user", content: text }
        ],
        temperature: sysPrompt ? 0.1 : 0.4,
        max_tokens: maxTokens || 3000
      })
    });

    var raw = await resp.text();

    if (!resp.ok) {
      throw new Error("总结接口返回 " + resp.status + "：" + raw.slice(0, 200));
    }

    var data = JSON.parse(raw);
    var msg = data.choices && data.choices[0] && data.choices[0].message;
    var content = msg ? msg.content : "";

    if (!content) throw new Error("模型没返回内容");

    recordChatCost(model, data.usage);

    return parseJsonLoose(content);
  }

  // 把一整页 OCR 文字拆成 题目 / 答案 / 解析
  var SPLIT_SYSTEM = [
    "你是把一页数学内容的 OCR 文字拆成三个字段的助手。",
    "输入一般是一条题目，后面跟着它的解答或证明，可能还带「经验」「总结」「自证」「类似题目」这类补充。",
    "只输出一个 JSON 对象，不要代码块、不要任何解释：",
    '{"question":"...","answer":"...","analysis":"..."}',
    "规则：",
    "1. question 只放题目本身——题号、题干、以及「证明…」「求…」这类要求，不要带解答过程。",
    "2. answer 只放明确的最终答案或结论。原文只有证明过程、没有单独答案时，填空字符串。",
    "3. analysis 放剩下的全部：证明过程、推导、「经验」总结、补充说明、相似题型提示。",
    "4. 公式和符号原样保留，不要改写、不要自己补内容、不要翻译。",
    "5. 三个字段都必须是字符串，没有内容就给空字符串。"
  ].join("\n");

  async function chatSplit(md, key) {
    var lastErr = null;

    for (var i = 0; i < CHAT_MODELS.length; i++) {
      try {
        var obj = await chatOnce(CHAT_MODELS[i], md, key, SPLIT_SYSTEM, 2000);
        if (obj && (obj.question || obj.answer || obj.analysis)) return obj;
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error("拆分没成");
  }

  async function chatSummary(text, key, opts) {
    var sys = (opts && opts.long) ? SUMMARY_SYSTEM_LONG : SUMMARY_SYSTEM;
    var maxTok = (opts && opts.maxTokens) || 3000;
    var lastErr = null;

    for (var i = 0; i < CHAT_MODELS.length; i++) {
      try {
        return await chatOnce(CHAT_MODELS[i], text, key, sys, maxTok);
      } catch (err) {
        lastErr = err;
      }
    }

    throw lastErr || new Error("总结失败，换个模型也没成");
  }

  function cleanFormula(f) {
    var s = String(f || "").trim();
    s = s.replace(/^\$\$?/, "").replace(/\$\$?$/, "");
    s = s.replace(/^\\\[/, "").replace(/\\\]$/, "");
    s = s.replace(/^\\\(/, "").replace(/\\\)$/, "");
    return s.trim();
  }

  function summaryBlocksHtml(sec) {
    var points = Array.isArray(sec.points) ? sec.points : [];
    var formulas = Array.isArray(sec.formulas) ? sec.formulas : [];
    var quiz = Array.isArray(sec.quiz) ? sec.quiz : [];
    var html = "";

    if (points.length) {
      html += '<div class="sum-block"><h3>🔑 核心知识点</h3><ul class="sum-points">' +
        points.map(function (p) {
          return "<li>" + richText(p) + "</li>";
        }).join("") + "</ul></div>";
    }

    if (formulas.length) {
      html += '<div class="sum-block"><h3>🧮 关键公式</h3>' +
        formulas.map(function (f) {
          return '<div class="sum-formula">$$' + escapeHtml(cleanFormula(f)) + "$$</div>";
        }).join("") + "</div>";
    }

    if (quiz.length) {
      html += '<div class="sum-block"><h3>❓ 自测一下</h3>' +
        quiz.map(function (q, i) {
          var qq = q && typeof q === "object" ? q.q : q;
          var aa = q && typeof q === "object" ? q.a : "";

          return '<div class="quiz">' +
            '<div class="quiz__q">' + (i + 1) + ". " + richText(qq || "") + "</div>" +
            (aa
              ? '<button type="button" class="btn btn--tiny btn--ai quiz__toggle">看答案</button>' +
                '<div class="quiz__a" hidden>' + richText(aa) + "</div>"
              : "") +
            "</div>";
        }).join("") + "</div>";
    }

    return html;
  }

  // 每段用原图；只有小图（手机上同步回来的）就退回小图
  function secImg(sec) {
    return sec.image || sec.thumb || "";
  }

  function renderSummary(d) {
    var secs = Array.isArray(d.sections) && d.sections.length ? d.sections : null;

    var html = '<div class="sum-head"><h2>' + escapeHtml(d.title || "总结") + "</h2>";

    if (!secs && d.summary) html += "<p>" + richText(d.summary) + "</p>";
    if (secs && secs.length > 1) {
      html += '<p class="sum-head__hint">一共 ' + secs.length +
        " 段，每段单独成节（图片 / 文档都算）</p>";
    }
    html += "</div>";

    if (secs) {
      secs.forEach(function (sec, i) {
        var im = secImg(sec);
        var label = sec.from
          ? escapeHtml(sec.from)
          : "第 " + (sec.idx != null ? sec.idx + 1 : i + 1) + " 张";

        html += '<section class="sum-sec">' +
          '<div class="sum-sec__top">' +
          (im
            ? '<img class="sum-sec__thumb" src="' + im + '" alt="" loading="lazy" />'
            : '<div class="sum-sec__thumb sum-sec__thumb--doc">📄</div>') +
          '<div class="sum-sec__no' + (sec.from ? " sum-sec__no--from" : "") + '">' + label + "</div>" +
          '<h3 class="sum-sec__title">' + escapeHtml(sec.title || "总结") + "</h3>" +
          "</div>" +
          (sec.summary ? '<p class="sum-sec__sum">' + richText(sec.summary) + "</p>" : "") +
          summaryBlocksHtml(sec) +
          "</section>";
      });
    } else {
      html += summaryBlocksHtml(d);
    }

    html += '<div class="sum-meta">' +
      escapeHtml(new Date().toLocaleString("zh-CN")) + "</div>";

    var box = $("sumResult");
    box.innerHTML = html;

    box.querySelectorAll(".quiz__toggle").forEach(function (b) {
      b.addEventListener("click", function () {
        var a = b.nextElementSibling;
        if (!a) return;
        a.hidden = !a.hidden;
        b.textContent = a.hidden ? "看答案" : "收起";
      });
    });

    renderMath(box);
  }

  /* ---------------- 跑一半的草稿 ---------------- */

  function draftData() {
    return {
      id: "summary",
      at: Date.now(),
      total: sum.images.length + sum.texts.length,
      images: sum.images.slice(),
      thumbs: sum.thumbs.slice(),
      texts: sum.texts.slice(),
      sections: sum.sections.slice(),
      failed: sum.failed.slice(),
      done: sum.done.slice()
    };
  }

  async function saveDraft(forceImages) {
    try {
      var d = draftData();
      var prev = sum.draft;

      // 图没变就别每次都重写十来兆，只更进度
      if (!forceImages && prev &&
          prev.total === d.total &&
          Array.isArray(prev.images) && prev.images.length === d.images.length) {
        d.images = prev.images;
        d.thumbs = prev.thumbs;
      }

      await dbPut(d, DRAFT_STORE);
      sum.draft = d;
    } catch (e) { /* 存不下也不能挡住主流程 */ }
  }

  async function clearDraft() {
    sum.draft = null;
    try { await dbDelete("summary", DRAFT_STORE); } catch (e) { /* 没有就算了 */ }
  }

  // 顶上那条「上次跑到 12/50」的提示
  function refreshDraftBar() {
    var bar = $("sumDraftBar");
    var txt = $("sumDraftText");
    if (!bar) return;

    var d = sum.draft;
    var left = d ? Math.max(0, (d.total || 0) - (d.done || []).length) : 0;

    if (!d || left <= 0) {
      bar.hidden = true;
      return;
    }

    if (txt) {
      txt.textContent = "上次跑到 " + (d.done || []).length + "/" + d.total +
        " 段，还剩 " + left + " 段没跑";
    }
    bar.hidden = false;
  }

  // 把已经跑出来的段落先摆到右边，别让老大干等一大片空白
  function showPartial() {
    if (!sum.sections.length) return;

    var secs = sum.sections.slice().sort(function (a, b) { return a.idx - b.idx; });
    var d = {
      title: secs.length > 1 ? secs[0].title + " 等 " + secs.length + " 段" : secs[0].title,
      sections: secs
    };

    sum.current = d;
    renderSummary(d);

    $("sumEmpty").hidden = true;
    $("sumResult").hidden = false;
    $("sumToolbar").hidden = false;
    $("sumEdit").hidden = true;

    var retry = $("sumRetry");
    if (retry) {
      retry.hidden = !sum.failed.length;
      retry.textContent = "🔁 重跑没读出来的（" + sum.failed.length + "）";
    }

    updateSaveBtn();
  }

  /* ---------- 文档分节：每页 / 每章 / 整份 ---------- */

  // 「《x》第 12 页」-> 12
  function pageNoOf(label) {
    var m = /第\s*(\d+)\s*页/.exec(label || "");
    return m ? Number(m[1]) : 0;
  }

  // 章标题长什么样：第3章 / 第三章 / 一、xxx / 3.1 xxx / Chapter 3 / §3
  var CHAP_HEAD = /^\s*(?:第\s*[0-9一二三四五六七八九十百零〇]{1,4}\s*[章节講讲篇卷部]|chapter\s*\d+|§\s*\d+|[一二三四五六七八九十]{1,3}\s*[、.．]\s*\S|\d+\.\d+\s+\S)/i;

  // 把文档页收成一串按页排好的 [{page,label,text}]；扫描页先 OCR 才有字
  async function collectDocPages(key) {
    if (sum.texts.length) {
      var pages = sum.texts.map(function (t) {
        return { page: pageNoOf(t.label), label: t.label || "文档", text: t.text || "" };
      }).sort(function (a, b) { return (a.page || 1e9) - (b.page || 1e9); });

      return { pages: pages, scanned: false };
    }

    var idxs = [];
    Object.keys(sum.docImgs).forEach(function (k) { idxs.push(Number(k)); });
    idxs.sort(function (a, b) { return a - b; });

    var out = [];

    for (var n = 0; n < idxs.length; n++) {
      if (sum.stop) return null;

      var i = idxs[n];
      var text = sum.pageText[i];

      if (text == null) {
        sumStatus("先把扫描页认成字… " + (n + 1) + "/" + idxs.length);
        try { text = await ocrOne(sum.images[i], key); } catch (e) { text = ""; }
        sum.pageText[i] = text;
      }

      out.push({ page: n + 1, label: "第 " + (n + 1) + " 页", text: text || "" });
    }

    return { pages: out, scanned: true };
  }

  // 按章切：把所有页拼起来，按「行」找章标题（第 X 章 / 一、 / 3.1 …）；
  // 一章太长再切成几块；一个章标题都认不出来就退回「每 N 页一节」
  function chapterGroups(pages, fallbackSize) {
    var lines = [];

    pages.forEach(function (p) {
      String(p.text || "").split(/\n+/).forEach(function (ln) {
        var s = ln.trim();
        if (s) lines.push({ text: s, page: p.page });
      });
    });

    var marks = [];
    lines.forEach(function (ln, i) {
      if (ln.text.length <= 42 && CHAP_HEAD.test(ln.text)) marks.push(i);
    });

    if (marks.length >= 2) {
      var groups = [];

      for (var k = 0; k < marks.length; k++) {
        var a = marks[k];
        var b = (k + 1 < marks.length) ? marks[k + 1] : lines.length;
        var title = lines[a].text;
        var body = lines.slice(a, b).map(function (x) { return x.text; }).join("\n").trim();

        if (!body) continue;

        var chunks = chunkText(body, 7000) || [];
        chunks.forEach(function (t, i) {
          groups.push({
            label: chunks.length > 1 ? title + "（" + (i + 1) + "/" + chunks.length + "）" : title,
            text: t
          });
        });
      }

      if (groups.length) return { groups: groups, fallback: false };
    }

    // 一个章标题都没认出来：按页数硬分组
    var noPage = pages.every(function (p) { return !p.page; });
    var step = fallbackSize || 6;
    var groups2 = [];

    for (var s2 = 0; s2 < pages.length; s2 += step) {
      var chunk2 = pages.slice(s2, s2 + step);
      var text2 = chunk2.map(function (x) { return x.text; }).filter(Boolean).join("\n\n").trim();

      if (!text2) continue;

      var from = chunk2[0].page;
      var to = chunk2[chunk2.length - 1].page;
      var label2;

      if (noPage) {
        var a2 = s2 + 1;
        var b2 = s2 + chunk2.length;
        label2 = (a2 === b2) ? "第 " + a2 + " 段" : "第 " + a2 + "–" + b2 + " 段";
      } else {
        label2 = (!from || from === to) ? "第 " + (from || 1) + " 页" : "第 " + from + "–" + to + " 页";
      }

      groups2.push({ label: label2, text: text2 });
    }

    return { groups: groups2, fallback: true };
  }

  // 整份一起：合成一大段，超长就切成几大块（每块仍是一整份的一部分，不是一页）
  function wholeGroups(pages) {
    var all = pages.map(function (p) { return p.text; }).filter(Boolean).join("\n\n");
    var parts = chunkText(all, 7000) || [];

    return {
      groups: parts.map(function (t, i) {
        return {
          label: parts.length > 1 ? "全文 " + (i + 1) + "/" + parts.length : "全文",
          text: t
        };
      }),
      fallback: false
    };
  }

  // 按所选粒度跑文档；顺带把单独放进去的照片也按张跑掉
  async function runDocGrouped(gran, key) {
    var packed = await collectDocPages(key);
    if (!packed || !packed.pages.length) return { total: 0, fallback: false };
    if (sum.stop) return { total: 0, fallback: false };

    var built = gran === "whole" ? wholeGroups(packed.pages) : chapterGroups(packed.pages, 6);
    var groups = built.groups;

    var photos = [];
    sum.images.forEach(function (src, i) { if (!sum.docImgs[i]) photos.push(i); });

    var total = groups.length + photos.length;
    var cursor = 0;

    for (var g = 0; g < groups.length; g++) {
      if (sum.stop) break;

      sumStatus("正在总结「" + groups[g].label + "」（" + (g + 1) + "/" + groups.length +
        "）…已存 " + sum.sections.length + " 段");
      sum.done.push(cursor);

      var part = null;
      try {
        part = await chatSummary("【" + groups[g].label + "】\n" + groups[g].text, key,
          { long: true, maxTokens: 6000 });
      } catch (e) { part = null; }

      if (!part) sum.failed.push(cursor);
      else {
        sum.sections.push({
          idx: cursor,
          title: part.title || groups[g].label,
          summary: part.summary || "",
          points: Array.isArray(part.points) ? part.points : [],
          formulas: Array.isArray(part.formulas) ? part.formulas : [],
          quiz: Array.isArray(part.quiz) ? part.quiz : [],
          image: "",
          thumb: "",
          from: groups[g].label
        });
      }

      cursor++;
      showPartial();
    }

    for (var p = 0; p < photos.length; p++) {
      if (sum.stop) break;

      var idx = photos[p];
      sumStatus("正在识别第 " + (idx + 1) + " 张照片…（" + (p + 1) + "/" + photos.length + "）");
      sum.done.push(cursor);

      var md = "";
      try { md = await ocrOne(sum.images[idx], key); } catch (e) { md = ""; }

      var sp = null;
      if (md) {
        try { sp = await chatSummary("【第 " + (idx + 1) + " 张】\n" + md, key); } catch (e) { sp = null; }
      }

      if (!sp) sum.failed.push(cursor);
      else {
        sum.sections.push({
          idx: cursor,
          title: sp.title || ("第 " + (idx + 1) + " 张"),
          summary: sp.summary || "",
          points: Array.isArray(sp.points) ? sp.points : [],
          formulas: Array.isArray(sp.formulas) ? sp.formulas : [],
          quiz: Array.isArray(sp.quiz) ? sp.quiz : [],
          image: sum.images[idx] || "",
          thumb: sum.thumbs[idx] || "",
          from: ""
        });
      }

      cursor++;
      showPartial();
    }

    return { total: total, fallback: built.fallback };
  }

  async function runSummary(opts) {
    opts = opts || {};

    if (sum.busy) return;

    var key = getApiKey();

    if (!key) {
      sumStatus("还没填 API Key，点右上角「🔑」填一下", "err");
      return;
    }

    if (!sum.images.length && !sum.texts.length) {
      sumStatus("先放一张图或者一个文档进来", "err");
      return;
    }

    var total = sum.images.length + sum.texts.length;
    var only = Array.isArray(opts.only) ? opts.only.slice() : null;

    // 选了「每章一节 / 整份一起」而且队列里有文档：先合并再总结
    var grouped = !only && sum.gran !== "page" &&
      (sum.texts.length > 0 || Object.keys(sum.docImgs).length > 0);

    // 从头跑：清空进度；接着跑/重跑：保留已经跑出来的
    if (!only) {
      sum.sections = [];
      sum.failed = [];
      sum.done = [];
    }

    var todo = only || (function () {
      var arr = [];
      for (var n = 0; n < total; n++) arr.push(n);
      return arr;
    })();

    // 已经有结果的先剔掉，防止重复
    todo = todo.filter(function (i) {
      return !sum.sections.some(function (s) { return s.idx === i; });
    });

    if (!todo.length && !grouped) {
      sumStatus("没有要跑的了", "ok");
      return;
    }

    sum.busy = true;
    sum.stop = false;

    var btn = $("sumRun");
    var stopBtn = $("sumStop");

    btn.disabled = true;
    if (stopBtn) { stopBtn.hidden = false; stopBtn.disabled = false; }

    try {
      if (grouped) {
        var gres = await runDocGrouped(sum.gran, key);
        total = gres.total;
        if (gres.fallback) toast("没认出章节标题，就按每 6 页一节合并了");
      } else {

      // 开跑先把图落一次盘，之后每张只更新进度
      await saveDraft(true);

      for (var k = 0; k < todo.length; k++) {
        if (sum.stop) break;

        var i = todo[k];
        var tag = (k + 1) + "/" + todo.length;
        var isPic = i < sum.images.length;
        var img = isPic ? sum.images[i] : "";
        var docText = isPic ? null : sum.texts[i - sum.images.length];

        if (!isPic && !docText) continue;   // 队列和图/文档对不上（删过东西），跳过

        var what = isPic
          ? "第 " + (i + 1) + "/" + total + " 张"
          : "《" + ((docText && docText.label) || "文档") + "》（" + tag + "）";

        var md = null;

        if (isPic) {
          sumStatus("正在识别" + what + "…已存 " + sum.sections.length + " 段");

          try {
            md = await ocrOne(img, key);
          } catch (e) {
            md = "";
          }

          if (sum.stop) break;
        } else {
          // 文档已经抽好字了，不用再识别，直接交给模型
          md = docText ? docText.text : "";
          sumStatus("正在看懂 " + what + "…已存 " + sum.sections.length + " 段");
        }

        var part = null;

        if (md) {
          if (isPic) sumStatus("正在总结" + what + "…每张都要单拎出来说");
          try {
            part = await chatSummary("【" + (docText ? docText.label : "第 " + (i + 1) + " 张") + "】\n" + md, key);
          } catch (e) {
            part = null;
          }
        }

        if (sum.done.indexOf(i) < 0) sum.done.push(i);

        if (!part) {
          if (sum.failed.indexOf(i) < 0) sum.failed.push(i);
        } else {
          sum.failed = sum.failed.filter(function (x) { return x !== i; });
          sum.sections.push({
            idx: i,
            title: part.title || (docText ? (docText.label || "文档") : "第 " + (i + 1) + " 张"),
            summary: part.summary || "",
            points: Array.isArray(part.points) ? part.points : [],
            formulas: Array.isArray(part.formulas) ? part.formulas : [],
            quiz: Array.isArray(part.quiz) ? part.quiz : [],
            image: img || "",
            thumb: isPic ? (sum.thumbs[i] || "") : "",
            from: docText ? docText.label : ""
          });
        }

        // 每跑完一张就落一次盘，关页面、断网都不亏
        await saveDraft();
        showPartial();
      }

      }   // ← 分段模式结束

      var left = total - sum.done.length;

      if (sum.stop) {
        sumStatus("停下了 · 已经存了 " + sum.sections.length + " 段，还剩 " +
          Math.max(0, left) + " 段，点「接着跑」继续", "err");
      } else if (left > 0 && sum.failed.length) {
        sumStatus("跑完了 · " + sum.sections.length + " 段成了，" + sum.failed.length +
          " 段没读出来（" + sum.failed.map(function (x) { return x + 1; }).join("、") +
          "），可以点「重跑没读出来的」再试一次", "err");
      } else {
        await clearDraft();
        var okMsg = "总结好了 ✓ " + sum.sections.length + " 段，每段各自成节";
        if (sum.failed.length) okMsg += "（" + sum.failed.length + " 段没读出来）";
        sumStatus(okMsg, "ok");
      }

      if (!sum.sections.length) throw new Error("一段都没总结出来，检查下图清不清楚 / 文档里有没有字");

      sum.current = {
        title: sum.sections.length > 1
          ? sum.sections[0].title + " 等 " + sum.sections.length + " 段"
          : sum.sections[0].title,
        sections: sum.sections.slice().sort(function (a, b) { return a.idx - b.idx; })
      };
      sum.currentId = null;

      showPartial();
      refreshDraftBar();
    } catch (err) {
      var msg = (err && err.message) ? err.message : String(err);

      if (/Failed to fetch|NetworkError|Load failed|Network request failed/i.test(msg)) {
        msg = "请求发不出去（多半是浏览器跨域限制）";
      }

      sumStatus("出错了：" + msg, "err");
      await saveDraft();
      refreshDraftBar();
    } finally {
      sum.busy = false;
      sum.stop = false;
      btn.disabled = false;
      if (stopBtn) stopBtn.hidden = true;
      refreshDraftBar();
    }
  }

  // 「接着跑」：把草稿捡回来，只跑没跑完的
  async function resumeDraft() {
    var d = sum.draft;
    if (!d) return;

    sum.images = Array.isArray(d.images) ? d.images.slice() : [];
    sum.thumbs = Array.isArray(d.thumbs) ? d.thumbs.slice() : [];
    sum.texts = Array.isArray(d.texts) ? d.texts.slice() : [];
    sum.sections = Array.isArray(d.sections) ? d.sections.slice() : [];
    sum.failed = Array.isArray(d.failed) ? d.failed.slice() : [];
    sum.done = Array.isArray(d.done) ? d.done.slice() : [];

    rehashImages();
    renderThumbs();
    showPartial();

    var left = [];
    for (var i = 0; i < sum.images.length + sum.texts.length; i++) {
      if (sum.done.indexOf(i) < 0) left.push(i);
    }

    sumStatus("接着跑 · 还剩 " + left.length + " 张", "ok");

    if (left.length) await runSummary({ only: left });
  }

  /* ---------------- 总结：保存 / 存错题 / 复制 ---------------- */

  function updateSaveBtn() {
    var b = $("sumSave");
    var ed = $("sumEdit");
    if (!b) return;

    if (ed) ed.hidden = !sum.currentId;

    if (sum.currentId) {
      b.textContent = "✅ 已保存";
      b.classList.add("btn--saved");
      b.disabled = true;
    } else {
      b.textContent = "💾 保存这次总结";
      b.classList.remove("btn--saved");
      b.disabled = false;
    }
  }

  // 一条总结里所有能搜到的字
  function summaryBlob(s) {
    var parts = [s.title || "", s.summary || ""];

    (s.points || []).forEach(function (p) { parts.push(String(p || "")); });
    (s.formulas || []).forEach(function (f) { parts.push(String(f || "")); });
    (s.quiz || []).forEach(function (q) {
      if (q && typeof q === "object") { parts.push(String(q.q || ""), String(q.a || "")); }
      else parts.push(String(q || ""));
    });
    (s.sections || []).forEach(function (sec) {
      parts.push(sec.title || "", sec.summary || "");
      (sec.points || []).forEach(function (p) { parts.push(String(p || "")); });
    });

    return parts.join(" ").toLowerCase();
  }

  function renderSavedList() {
    var box = $("sumSavedList");
    var count = $("sumSavedCount");
    if (!box) return;

    if (count) count.textContent = sum.saved.length;

    var search = $("sumSearch");
    if (search) search.hidden = !sum.saved.length;

    // 清掉已经不存在的选中项
    var alive = {};
    sum.saved.forEach(function (s) { alive[s.id] = 1; });
    Object.keys(sum.selected).forEach(function (k) {
      if (!alive[k]) delete sum.selected[k];
    });

    if (!sum.saved.length) {
      box.innerHTML = '<div class="sum-saved__empty">还没有存过</div>';
      updateSavedBar();
      return;
    }

    var q = String(sum.query || "").trim().toLowerCase();
    var shown = q
      ? sum.saved.filter(function (s) { return summaryBlob(s).indexOf(q) >= 0; })
      : sum.saved;

    if (!shown.length) {
      box.innerHTML = '<div class="sum-saved__empty">没搜到「' + escapeHtml(sum.query) + '」</div>';
      updateSavedBar();
      return;
    }

    box.innerHTML = shown.map(function (s) {
      var picked = !!sum.selected[s.id];

      return '<div class="sum-saved__item' + (s.id === sum.currentId ? " is-active" : "") +
        (picked ? " is-picked" : "") + '" data-id="' + s.id + '">' +
        '<input type="checkbox" class="sum-saved__check" data-check="' + s.id + '"' +
        (picked ? " checked" : "") + " />" +
        '<div class="sum-saved__text">' +
          '<div class="sum-saved__name">' + escapeHtml(s.title || "总结") + "</div>" +
          '<div class="sum-saved__date">' + fmtDate(s.createdAt) + "</div>" +
        "</div>" +
        '<button type="button" class="sum-saved__del" data-del="' + s.id +
        '" title="删除这条">✕</button>' +
      "</div>";
    }).join("");

    box.querySelectorAll(".sum-saved__item").forEach(function (el) {
      el.addEventListener("click", function (e) {
        if (e.target.closest(".sum-saved__del")) return;
        if (e.target.classList.contains("sum-saved__check")) return;
        openSavedSummary(el.dataset.id);
      });
    });

    box.querySelectorAll(".sum-saved__check").forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (cb.checked) sum.selected[cb.dataset.check] = 1;
        else delete sum.selected[cb.dataset.check];

        var item = cb.closest(".sum-saved__item");
        if (item) item.classList.toggle("is-picked", cb.checked);

        updateSavedBar();
      });
    });

    box.querySelectorAll(".sum-saved__del").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        deleteSavedSummary(b.dataset.del);
      });
    });

    updateSavedBar();
  }

  function pickedIds() {
    return Object.keys(sum.selected).filter(function (k) { return sum.selected[k]; });
  }

  function updateSavedBar() {
    var bar = $("sumSavedBar");
    if (bar) bar.hidden = !sum.saved.length;

    var n = pickedIds().length;
    var btn = $("sumExport");
    if (btn) {
      btn.textContent = "🖨️ 导出选中（" + n + "）";
      btn.disabled = n === 0;
    }
  }

  /* ---------------- 导出 PDF ---------------- */

  function buildFileName(items) {
    var t = new Date((items[0] && items[0].createdAt) || Date.now());
    var mm = String(t.getMonth() + 1).padStart(2, "0");
    var dd = String(t.getDate()).padStart(2, "0");

    var tail = items.length === 1 ? (items[0].title || "总结") : items.length + "节";
    tail = String(tail).replace(/[\\/:*?"<>|]/g, "").slice(0, 24);

    return "学习总结-" + t.getFullYear() + "-" + mm + "-" + dd + "-" + tail;
  }

  // 一节的内容量（按字数估，公式折 40 字，图折 120 字）
  function sumWeight(it) {
    var n = String(it.summary || "").length;
    (it.points || []).forEach(function (p) { n += String(p).length; });
    (it.quiz || []).forEach(function (q) {
      n += String((q && q.q) || "").length + String((q && q.a) || "").length;
    });
    (it.formulas || []).forEach(function () { n += 40; });
    if (it.image) n += 120;
    return n;
  }

  var THIN_SECTION = 900;

  // 内容太少的节并到上一节里，自己降成子标题
  function mergeThinItems(list) {
    var groups = [];

    list.forEach(function (it) {
      // 带图的、或者自带分段的，都单独成一节，别被合并掉
      var keepOwn = it.image || (Array.isArray(it.images) && it.images.length);

      if (groups.length && !keepOwn && sumWeight(it) <= THIN_SECTION) {
        groups[groups.length - 1].subs.push(it);
      } else {
        groups.push({ main: it, subs: [] });
      }
    });

    return groups;
  }

  function printSectionBody(it, isSub) {
    var points = Array.isArray(it.points) ? it.points : [];
    var formulas = Array.isArray(it.formulas) ? it.formulas : [];
    var quiz = Array.isArray(it.quiz) ? it.quiz : [];
    var imgs = Array.isArray(it.images) && it.images.length
      ? it.images
      : (it.image ? [it.image] : []);
    var out = [];

    if (isSub) out.push('<h3 class="print-subtitle">' + escapeHtml(it.title || "补充") + "</h3>");

    // 只有一张就放在正文上头；有好几张就统一附在节末，别把正文挤下去
    if (imgs.length === 1) {
      out.push('<figure class="print-fig"><img src="' + imgs[0] + '" alt="" /></figure>');
    }

    if (it.summary) out.push('<p class="print-sum">' + richText(it.summary) + "</p>");

    if (points.length) {
      out.push('<h3 class="print-h3">核心知识点</h3><ul class="print-points">');
      points.forEach(function (p) { out.push("<li>" + richText(p) + "</li>"); });
      out.push("</ul>");
    }

    if (formulas.length) {
      out.push('<h3 class="print-h3">关键公式</h3>');
      formulas.forEach(function (f) {
        out.push('<div class="print-formula">$$' + escapeHtml(cleanFormula(f)) + "$$</div>");
      });
    }

    if (quiz.length) {
      out.push('<h3 class="print-h3">自测</h3><ol class="print-quiz">');
      quiz.forEach(function (q) {
        var qq = (q && q.q) || "";
        var aa = (q && q.a) || "";
        out.push("<li>" + richText(qq) +
          (aa ? '<div class="print-ans">答：' + richText(aa) + "</div>" : "") + "</li>");
      });
      out.push("</ol>");
    }

    if (imgs.length > 1) {
      out.push('<h3 class="print-h3">原图 · ' + imgs.length + " 张</h3>");
      out.push('<div class="print-figs">');
      imgs.forEach(function (src) {
        out.push('<img src="' + src + '" alt="" />');
      });
      out.push("</div>");
    }

    return out.join("");
  }

  // 一条总结如果是「每张图一段」的，打出来就拆成好几节，每节带自己那张图
  function flattenSections(items) {
    var units = [];

    items.forEach(function (it) {
      if (Array.isArray(it.sections) && it.sections.length) {
        it.sections.forEach(function (sec) {
          units.push({
            title: sec.title,
            summary: sec.summary,
            points: sec.points,
            formulas: sec.formulas,
            quiz: sec.quiz,
            image: sec.image || sec.thumb || "",
            createdAt: it.createdAt
          });
        });
      } else {
        units.push(it);
      }
    });

    return units;
  }

  function buildPrintHtml(items) {
    var CN = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十",
      "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十"];

    var units = flattenSections(items);
    var groups = mergeThinItems(units);
    var out = [];

    out.push('<header class="print-head">');
    out.push("<h1>学习总结</h1>");

    var imgCount = 0;
    units.forEach(function (it) {
      if (Array.isArray(it.images) && it.images.length) imgCount += it.images.length;
      else if (it.image) imgCount += 1;
    });

    var meta = groups.length + " 节";
    if (imgCount) meta += " · " + imgCount + " 张原图";
    meta += " · " + fmtDate((items[0] && items[0].createdAt) || Date.now());

    out.push('<div class="print-meta">' + meta + "</div>");
    out.push("</header>");

    groups.forEach(function (g, i) {
      var no = CN[i] || String(i + 1);

      out.push('<section class="print-sec">');
      out.push('<h2 class="print-title">' + no + "、" + escapeHtml(g.main.title || "总结") + "</h2>");
      out.push(printSectionBody(g.main, false));

      g.subs.forEach(function (s) {
        out.push('<div class="print-sub">' + printSectionBody(s, true) + "</div>");
      });

      out.push("</section>");
    });

    return out.join("");
  }

  async function deleteMany(ids) {
    var snapshots = [];
    var i;

    for (i = 0; i < sum.saved.length; i++) {
      if (ids.indexOf(sum.saved[i].id) >= 0) snapshots.push(sum.saved[i]);
    }

    for (i = 0; i < ids.length; i++) {
      await dbDelete(ids[i], SUM_STORE);
      markDeleted(ids[i]);
      delete sum.selected[ids[i]];
    }

    if (sum.currentId && ids.indexOf(sum.currentId) >= 0) {
      sum.currentId = null;
      updateSaveBtn();
    }

    await loadSavedSummaries();

    toast("删掉了 " + ids.length + " 条", "撤销", async function () {
      for (var k = 0; k < snapshots.length; k++) {
        unmarkDeleted(snapshots[k].id);
        await dbPut(snapshots[k], SUM_STORE);
      }
      await loadSavedSummaries();
      toast("都回来了");
    });

    syncSoon(7000);
  }

  function exportPdf() {
    var ids = pickedIds();

    if (!ids.length) {
      toast("先勾几条");
      return;
    }

    var items = sum.saved.filter(function (s) { return ids.indexOf(s.id) >= 0; });
    items.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });

    var area = $("printArea");
    area.innerHTML = buildPrintHtml(items);
    renderMath(area);

    var oldTitle = document.title;
    document.title = buildFileName(items);

    var finished = false;

    function done() {
      if (finished) return;
      finished = true;

      document.title = oldTitle;
      area.innerHTML = "";

      setTimeout(function () {
        if (confirm("导出完了。\n要把勾选的这 " + items.length + " 条从记录里删掉吗？")) {
          deleteMany(items.map(function (x) { return x.id; })).catch(function (err) {
            toast("删除失败：" + err.message);
          });
        }
      }, 200);
    }

    window.addEventListener("afterprint", done, { once: true });

    try {
      window.print();
    } catch (e) {
      done();
      toast("调不起打印：" + e.message);
      return;
    }

    // 有的浏览器不派发 afterprint，兜个底
    setTimeout(done, 60000);
  }

  async function loadSavedSummaries() {
    try {
      var all = await dbGetAll(SUM_STORE);
      sum.saved = (all || []).sort(function (a, b) {
        return (b.createdAt || 0) - (a.createdAt || 0);
      });
    } catch (e) {
      sum.saved = [];
    }
    renderSavedList();
  }

  async function saveCurrentSummary() {
    if (!sum.current || sum.currentId) return;

    var d = sum.current;
    var now = Date.now();

    var item = {
      id: uid(),
      title: d.title || "总结",
      summary: d.summary || "",
      points: Array.isArray(d.points) ? d.points : [],
      formulas: Array.isArray(d.formulas) ? d.formulas : [],
      quiz: Array.isArray(d.quiz) ? d.quiz : [],
      sections: Array.isArray(d.sections) ? d.sections : [],
      image: sum.images[0] || "",
      images: sum.images.slice(),
      thumbs: sum.thumbs.slice(),
      createdAt: now,
      updatedAt: now
    };

    await dbPut(item, SUM_STORE);
    sum.currentId = item.id;

    updateSaveBtn();
    await loadSavedSummaries();
    toast("存好了，以后在左边能翻到");
  }

  function openSavedSummary(id) {
    var s = sum.saved.find(function (x) { return x.id === id; });
    if (!s) return;

    sum.current = s;
    sum.currentId = s.id;
    sum.editing = false;

    sum.images = Array.isArray(s.images) && s.images.length
      ? s.images.slice()
      : (s.image ? [s.image] : []);
    sum.thumbs = Array.isArray(s.thumbs) ? s.thumbs.slice() : [];

    rehashImages();
    renderThumbs();
    renderSummary(s);

    $("sumEmpty").hidden = true;
    $("sumResult").hidden = false;
    $("sumToolbar").hidden = false;

    if ($("sumRetry")) $("sumRetry").hidden = true;

    updateSaveBtn();
    renderSavedList();
    sumStatus("翻出来的是 " + fmtDate(s.createdAt) + " 存的");
  }

  /* ---------------- 改字（只对存过的总结） ---------------- */

  function toggleEditSummary() {
    if (!sum.currentId || !sum.current) return;

    sum.editing = !sum.editing;

    if (!sum.editing) {
      renderSummary(sum.current);
      updateSaveBtn();
      return;
    }

    renderSummaryEdit(sum.current);
  }

  function editTextarea(label, field, value, rows) {
    return '<label class="sum-edit__field">' +
      "<span>" + label + "</span>" +
      '<textarea data-f="' + field + '" rows="' + (rows || 3) + '">' +
      escapeHtml(value || "") + "</textarea></label>";
  }

  function renderSummaryEdit(d) {
    var secs = Array.isArray(d.sections) && d.sections.length ? d.sections : null;
    var html = '<div class="sum-edit">' +
      '<div class="sum-edit__tip">公式照旧写 $...$，改完点下面的「存修改」</div>' +
      '<label class="sum-edit__field"><span>大标题</span>' +
      '<input data-f="title" value="' + escapeHtml(d.title || "") + '" /></label>';

    if (!secs) {
      html += editTextarea("概括", "summary", d.summary, 4) +
        editTextarea("知识点（一行一条）", "points", (d.points || []).join("\n"), 5) +
        editTextarea("公式（一行一条）", "formulas", (d.formulas || []).join("\n"), 4);
    } else {
      secs.forEach(function (sec, i) {
        html += '<div class="sum-edit__sec" data-i="' + i + '">' +
          '<div class="sum-edit__no">第 ' + (i + 1) + " 段</div>" +
          '<label class="sum-edit__field"><span>小标题</span>' +
          '<input data-f="title" value="' + escapeHtml(sec.title || "") + '" /></label>' +
          editTextarea("概括", "summary", sec.summary, 3) +
          editTextarea("知识点（一行一条）", "points", (sec.points || []).join("\n"), 5) +
          editTextarea("公式（一行一条）", "formulas", (sec.formulas || []).join("\n"), 3) +
          "</div>";
      });
    }

    html += '<div class="sum-edit__acts">' +
      '<button type="button" class="btn btn--primary btn--tiny" id="sumEditSave">存修改</button>' +
      '<button type="button" class="btn btn--ghost btn--tiny" id="sumEditCancel">算了</button>' +
      "</div></div>";

    var box = $("sumResult");
    box.innerHTML = html;

    var saveBtn = $("sumEditSave");
    var cancelBtn = $("sumEditCancel");

    if (cancelBtn) {
      cancelBtn.addEventListener("click", function () {
        sum.editing = false;
        renderSummary(sum.current);
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", function () { saveEditedSummary(d); });
    }
  }

  function linesOf(v) {
    return String(v || "").split(/\r?\n/).map(function (x) { return x.trim(); })
      .filter(Boolean);
  }

  async function saveEditedSummary(d) {
    var box = $("sumResult");
    if (!box) return;

    var titleEl = box.querySelector('input[data-f="title"]');
    if (titleEl) d.title = titleEl.value.trim();

    var secs = Array.isArray(d.sections) && d.sections.length ? d.sections : null;

    if (!secs) {
      var s1 = box.querySelector('textarea[data-f="summary"]');
      var p1 = box.querySelector('textarea[data-f="points"]');
      var f1 = box.querySelector('textarea[data-f="formulas"]');

      if (s1) d.summary = s1.value.trim();
      if (p1) d.points = linesOf(p1.value);
      if (f1) d.formulas = linesOf(f1.value);
    } else {
      box.querySelectorAll(".sum-edit__sec").forEach(function (el) {
        var i = Number(el.dataset.i);
        var sec = d.sections[i];
        if (!sec) return;

        var t = el.querySelector('input[data-f="title"]');
        var s = el.querySelector('textarea[data-f="summary"]');
        var p = el.querySelector('textarea[data-f="points"]');
        var f = el.querySelector('textarea[data-f="formulas"]');

        if (t) sec.title = t.value.trim();
        if (s) sec.summary = s.value.trim();
        if (p) sec.points = linesOf(p.value);
        if (f) sec.formulas = linesOf(f.value);
      });
    }

    d.updatedAt = Date.now();

    try {
      await dbPut(d, SUM_STORE);
      await loadSavedSummaries();
      sum.editing = false;
      renderSummary(d);
      updateSaveBtn();
      toast("改好了");
      syncSoon(1200);
    } catch (err) {
      toast("存不下：" + err.message);
    }
  }

  async function deleteSavedSummary(id) {
    var snapshot = null;
    var i;

    for (i = 0; i < sum.saved.length; i++) {
      if (sum.saved[i].id === id) { snapshot = sum.saved[i]; break; }
    }

    await dbDelete(id, SUM_STORE);
    markDeleted(id);

    if (sum.currentId === id) {
      sum.currentId = null;
      updateSaveBtn();
    }

    await loadSavedSummaries();

    toast("总结删掉了", "撤销", async function () {
      if (!snapshot) return;
      unmarkDeleted(id);
      await dbPut(snapshot, SUM_STORE);
      await loadSavedSummaries();
      toast("回来了");
    });

    syncSoon(7000);
  }

  function plainSectionLines(sec, idx, lines) {
    var points = Array.isArray(sec.points) ? sec.points : [];
    var formulas = Array.isArray(sec.formulas) ? sec.formulas : [];
    var quiz = Array.isArray(sec.quiz) ? sec.quiz : [];

    lines.push("", "— 第 " + (idx + 1) + " 段 · " + (sec.title || "总结") + " —");
    if (sec.summary) lines.push(sec.summary);

    if (points.length) {
      lines.push("", "· 核心知识点");
      points.forEach(function (p) { lines.push("  - " + p); });
    }

    if (formulas.length) {
      lines.push("", "· 关键公式");
      formulas.forEach(function (f) { lines.push("  " + f); });
    }

    if (quiz.length) {
      lines.push("", "· 自测");
      quiz.forEach(function (q, i) {
        lines.push("  " + (i + 1) + ". " + ((q && q.q) || ""));
        if (q && q.a) lines.push("     答：" + q.a);
      });
    }

    return lines;
  }

  function buildPlainText(d) {
    var lines = ["【" + (d.title || "总结") + "】"];

    if (Array.isArray(d.sections) && d.sections.length) {
      d.sections.forEach(function (sec, i) {
        plainSectionLines(sec, i, lines);
      });
      return lines.join("\n");
    }

    if (d.summary) lines.push(d.summary);

    var points = Array.isArray(d.points) ? d.points : [];
    if (points.length) {
      lines.push("", "· 核心知识点");
      points.forEach(function (p) { lines.push("  - " + p); });
    }

    var formulas = Array.isArray(d.formulas) ? d.formulas : [];
    if (formulas.length) {
      lines.push("", "· 关键公式");
      formulas.forEach(function (f) { lines.push("  " + f); });
    }

    var quiz = Array.isArray(d.quiz) ? d.quiz : [];
    if (quiz.length) {
      lines.push("", "· 自测");
      quiz.forEach(function (q, i) {
        lines.push("  " + (i + 1) + ". " + ((q && q.q) || ""));
        if (q && q.a) lines.push("     答：" + q.a);
      });
    }

    return lines.join("\n");
  }

  function copyText(text) {
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();

      try {
        document.execCommand("copy");
        toast("复制好了");
      } catch (e) {
        toast("复制不了，手动选一下吧");
      }

      document.body.removeChild(ta);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast("复制好了");
      }, fallback);
    } else {
      fallback();
    }
  }

  // 把当前总结变成一条错题
  async function toMistakeBook() {
    var d = sum.current;
    if (!d) return;

    // 分段式的就把每段的内容拼到一起
    var secs = Array.isArray(d.sections) && d.sections.length ? d.sections : [d];

    var points = [];
    var formulas = [];
    var quiz = [];
    var summaries = [];

    secs.forEach(function (s) {
      if (s.summary) summaries.push(s.summary);
      (s.points || []).forEach(function (p) { points.push(p); });
      (s.formulas || []).forEach(function (f) { formulas.push(f); });
      (s.quiz || []).forEach(function (q) { quiz.push(q); });
    });

    var answerLines = points.map(function (p) { return "· " + p; });

    var noteLines = summaries.slice();

    if (formulas.length) {
      noteLines.push("", "【公式】");
      formulas.forEach(function (f) { noteLines.push("$$" + cleanFormula(f) + "$$"); });
    }

    if (quiz.length) {
      noteLines.push("", "【自测】");
      quiz.forEach(function (q, i) {
        noteLines.push((i + 1) + ". " + ((q && q.q) || ""));
        if (q && q.a) noteLines.push("   答：" + q.a);
      });
    }

    var title = d.title || "总结";
    var now = Date.now();

    var item = {
      id: uid(),
      image: sum.images[0] || "",
      thumb: sum.thumbs[0] || "",
      subject: guessSubject(title + " " + points.join(" ")) || "其他",
      title: title,
      answer: answerLines.join("\n"),
      note: noteLines.join("\n"),
      tags: ["总结"],
      createdAt: now,
      updatedAt: now
    };

    await dbPut(item);
    await reload();
    toast("已经收进错题本了");
  }

  /* ---------------- 用量记账 / 余额预警 ---------------- */

  var SPEND_KEY = "mistake-book.spend";

  // 单价：元 / 百万 token
  var PRICE_OCR = 0.2;
  var PRICE_CHAT = {
    "glm-5.3-flash": { in: 0.8, out: 2.8 },
    // 老模型官方没公布价，按贵的算，宁可早一点预警
    "glm-4-flash": { in: 0.8, out: 2.8 },
    // 截图用的视觉模型
    "glm-4.5v": { in: 4, out: 16 }
  };

  function loadSpend() {
    var def = { spent: 0, base: null, baseAt: 0, spentSinceBase: 0 };

    try {
      var raw = localStorage.getItem(SPEND_KEY);
      if (!raw) return def;

      var o = JSON.parse(raw);
      return {
        spent: Number(o.spent) || 0,
        base: o.base == null ? null : Number(o.base),
        baseAt: Number(o.baseAt) || 0,
        spentSinceBase: Number(o.spentSinceBase) || 0
      };
    } catch (e) {
      return def;
    }
  }

  function saveSpend(s) {
    try { localStorage.setItem(SPEND_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ }
  }

  function tokenCount(usage) {
    if (!usage) return 0;

    var total = Number(usage.total_tokens) || 0;
    if (total > 0) return total;

    var a = Number(usage.prompt_tokens) || Number(usage.input_tokens) || 0;
    var b = Number(usage.completion_tokens) || Number(usage.output_tokens) || 0;
    return a + b;
  }

  function fmtMoney(n) {
    if (n >= 1) return "¥" + n.toFixed(2);
    if (n >= 0.01) return "¥" + n.toFixed(3);
    return "¥" + n.toFixed(4);
  }

  function charge(cost) {
    if (!(cost > 0)) return;

    var s = loadSpend();
    s.spent += cost;
    if (s.base != null) s.spentSinceBase += cost;

    saveSpend(s);
    updateWalletUI();
  }

  function recordOcrCost(usage) {
    var t = tokenCount(usage);
    if (!t) return;
    charge(t * PRICE_OCR / 1e6);
  }

  function recordChatCost(model, usage) {
    if (!usage) return;

    var p = PRICE_CHAT[model] || PRICE_CHAT["glm-5.3-flash"];
    var inT = Number(usage.prompt_tokens) || 0;
    var outT = Number(usage.completion_tokens) || 0;

    if (!inT && !outT) {
      charge(tokenCount(usage) * p.out / 1e6);
      return;
    }

    charge((inT * p.in + outT * p.out) / 1e6);
  }

  function walletLeft(s) {
    s = s || loadSpend();
    if (s.base == null) return null;
    return s.base - s.spentSinceBase;
  }

  function updateWalletUI() {
    var s = loadSpend();
    var left = walletLeft(s);

    var spentEl = $("walletSpent");
    if (spentEl) spentEl.textContent = fmtMoney(s.spent);

    var leftEl = $("walletLeft");
    if (leftEl) {
      if (left == null) {
        leftEl.textContent = "没填";
        leftEl.className = "is-empty";
      } else {
        leftEl.textContent = fmtMoney(left);
        leftEl.className = left < 1 ? "is-low" : "";
      }
    }

    var btn = $("btnWallet");
    if (btn) {
      if (left != null && left < 1) {
        btn.classList.add("is-warn");
        btn.textContent = left <= 0 ? "⚠ 没了" : "⚠ " + left.toFixed(2);
        btn.title = "余额快见底了，点开看看";
      } else {
        btn.classList.remove("is-warn");
        btn.textContent = "💰";
        btn.title = left == null
          ? "记一下余额，低于 1 元鱼会喊你"
          : "估算余额 " + fmtMoney(left);
      }
    }
  }

  /* ---------------- 多设备同步（GitHub Gist） ---------------- */

  var SYNC_KEY = "mistake-book.github";
  var DEL_KEY = "mistake-book.deleted";
  var GIST_FILE = "fish-study.json";
  var GH_API = "https://api.github.com";

  function loadSync() {
    try {
      var o = JSON.parse(localStorage.getItem(SYNC_KEY) || "{}");
      return { token: String(o.token || ""), gistId: String(o.gistId || "") };
    } catch (e) {
      return { token: "", gistId: "" };
    }
  }

  function saveSync(o) {
    try { localStorage.setItem(SYNC_KEY, JSON.stringify(o)); } catch (e) { /* 忽略 */ }
  }

  function loadDeleted() {
    try { return JSON.parse(localStorage.getItem(DEL_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveDeleted(o) {
    try { localStorage.setItem(DEL_KEY, JSON.stringify(o)); } catch (e) { /* 忽略 */ }
  }

  // 删掉的东西记一笔时间，免得下次同步又从云端拉回来
  function markDeleted(id) {
    if (!id) return;
    var d = loadDeleted();
    d[id] = Date.now();
    saveDeleted(d);
  }

  // 撤销删除：把这条「已删」记录划掉，别让它同步过去把别的设备也删了
  function unmarkDeleted(id) {
    if (!id) return;
    var d = loadDeleted();
    if (d[id]) {
      delete d[id];
      saveDeleted(d);
    }
  }

  // 撤销窗口过了再同步，免得刚点撤销就被云端合并掉
  function syncSoon(ms) {
    var s = loadSync();
    if (!s.token || !s.gistId) return;
    setTimeout(function () { syncNow(true); }, ms || 0);
  }

  function setSyncStatus(msg, type) {
    var el = $("syncStatus");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "sync-status" + (type ? " " + type : "");
  }

  function updateSyncUI() {
    var s = loadSync();
    var on = !!(s.token && s.gistId);

    var stateEl = $("syncState");
    if (stateEl) {
      stateEl.textContent = on ? "已连接" : "未连接";
      stateEl.className = "sync-state" + (on ? " is-on" : "");
    }

    var setup = $("syncSetup");
    if (setup) setup.hidden = on;

    var actions = $("syncActions");
    if (actions) actions.hidden = !on;

    var btn = $("btnSync");
    if (btn) btn.classList.toggle("is-on", on);
  }

  async function ghFetch(path, opts) {
    var s = loadSync();
    var headers = {
      "Accept": "application/vnd.github+json",
      "Authorization": "Bearer " + s.token,
      "X-GitHub-Api-Version": "2022-11-28"
    };

    var init = { method: (opts && opts.method) || "GET", headers: headers };

    if (opts && opts.body) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    var resp = await fetch(GH_API + path, init);
    var raw = await resp.text();

    if (!resp.ok) {
      var msg = raw.slice(0, 160);
      if (resp.status === 401) msg = "token 不对或者过期了";
      if (resp.status === 404) msg = "找不到这个 Gist";
      throw new Error("GitHub " + resp.status + " · " + msg);
    }

    return raw ? JSON.parse(raw) : {};
  }

  function emptyPayload() {
    return {
      app: "fish-study",
      version: 1,
      updatedAt: Date.now(),
      items: [],
      summaries: [],
      memos: [],
      deleted: {}
    };
  }

  // 先看看这个账号下有没有已经建过的同步 Gist。
  // 不然每台设备各建一个，两台各存各的，等于没同步。
  async function findGist() {
    try {
      var list = await ghFetch("/gists?per_page=100");
      if (!Array.isArray(list)) return "";

      var cands = list.filter(function (g) {
        var f = (g && g.files) || {};
        return Object.prototype.hasOwnProperty.call(f, GIST_FILE);
      });
      if (!cands.length) return "";

      var sizeOf = function (g) {
        var f = (g.files && g.files[GIST_FILE]) || {};
        return Number(f.size) || 0;
      };

      // 先挑数据多的：万一之前误建过空壳，别又连到空壳上去
      cands.sort(function (a, b) {
        var d = sizeOf(b) - sizeOf(a);
        if (d) return d;
        return new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime();
      });

      return cands[0].id || "";
    } catch (e) {
      return "";   // 列不出来就当没有，老老实实新建
    }
  }

  async function ensureGist() {
    var s = loadSync();
    if (s.gistId) return s.gistId;

    var found = await findGist();
    if (found) {
      s.gistId = found;
      saveSync(s);
      updateSyncUI();
      return found;
    }

    var files = {};
    files[GIST_FILE] = { content: JSON.stringify(emptyPayload()) };

    var data = await ghFetch("/gists", {
      method: "POST",
      body: {
        description: "fish-study 学习助手同步数据",
        public: false,
        files: files
      }
    });

    s.gistId = data.id;
    saveSync(s);
    updateSyncUI();

    return data.id;
  }

  async function readGist() {
    var s = loadSync();
    var data = await ghFetch("/gists/" + s.gistId);
    var f = data.files && data.files[GIST_FILE];

    if (!f) return emptyPayload();

    // 文件大了 GitHub 会把 content 截断，这时候得走 raw_url
    if (f.truncated && f.raw_url) {
      var r = await fetch(f.raw_url);
      return JSON.parse(await r.text());
    }

    return JSON.parse(f.content || "{}");
  }

  async function writeGist(payload) {
    var s = loadSync();
    var files = {};
    // 图片不进 Gist：几百 KB 一张，几十条就传不动了，只留个「这题有图」的标记
    files[GIST_FILE] = { content: JSON.stringify(slimPayload(payload)) };

    await ghFetch("/gists/" + s.gistId, {
      method: "PATCH",
      body: { files: files }
    });
  }

  function slimItem(it) {
    var c = {};
    var k;

    for (k in it) {
      if (!Object.prototype.hasOwnProperty.call(it, k)) continue;
      if (k === "image" || k === "imageCrop" || k === "images") continue;
      c[k] = it[k];
    }

    // 每张图那段里也塞着原图，得一起剥掉，留小图（不然一个 Gist 塞几十兆）
    if (Array.isArray(it.sections)) {
      c.sections = it.sections.map(function (sec) {
        var o = {};
        var kk;
        for (kk in sec) {
          if (!Object.prototype.hasOwnProperty.call(sec, kk)) continue;
          if (kk === "image") continue;
          o[kk] = sec[kk];
        }
        return o;
      });
    }

    if (it.image || (Array.isArray(it.images) && it.images.length)) c.imgLite = 1;

    return c;
  }

  function slimPayload(p) {
    return {
      app: p.app,
      version: p.version,
      updatedAt: p.updatedAt,
      items: (p.items || []).map(slimItem),
      summaries: (p.summaries || []).map(slimItem),
      memos: p.memos || [],
      deleted: p.deleted || {}
    };
  }

  // ---- 三方合并：最后一次同步时的样子当「共同祖先」 ----
  // 没有祖先的时候只能后写的赢（老行为）；有祖先就能看出「哪边改了哪个字段」，
  // 各改各的字段两边都留下，同一个字段撞车就把另一台的版本单独存一份。

  var BASE_KEY = "mistake-book.base";

  function loadBase() {
    try { return JSON.parse(localStorage.getItem(BASE_KEY) || "{}") || {}; }
    catch (e) { return {}; }
  }

  function saveBase(b) {
    try { localStorage.setItem(BASE_KEY, JSON.stringify(b)); }
    catch (e) { /* 存不下顶多退化成「后写的赢」 */ }
  }

  function baseSnapshot(data) {
    var out = { items: {}, summaries: {}, memos: {} };

    (data.items || []).forEach(function (it) {
      if (it && it.id) out.items[it.id] = slimItem(it);
    });
    (data.summaries || []).forEach(function (it) {
      if (it && it.id) out.summaries[it.id] = slimItem(it);
    });
    (data.memos || []).forEach(function (it) {
      if (it && it.id) out.memos[it.id] = it;
    });

    return out;
  }

  var IMG_FIELDS = { image: 1, imageCrop: 1, images: 1, thumb: 1, thumbs: 1 };

  // 这些是记账用的，不算「内容改了」——不然两边都在更新 updatedAt 就会误报冲突
  var META_FIELDS = { id: 1, updatedAt: 1, createdAt: 1, imgLite: 1, conflictOf: 1 };

  function sameVal(a, b) {
    if (a === b) return true;
    if (a == null && b == null) return true;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (e) { return false; }
  }

  function mergeData(local, remote) {
    var deleted = {};
    var k;

    var rDel = (remote && remote.deleted) || {};
    var lDel = (local && local.deleted) || {};

    for (k in rDel) if (rDel[k]) deleted[k] = rDel[k];
    for (k in lDel) if (lDel[k] && (!deleted[k] || lDel[k] > deleted[k])) deleted[k] = lDel[k];

    var base = loadBase();
    var conflicts = [];

    function indexBy(list) {
      var map = {};
      (list || []).forEach(function (it) { if (it && it.id) map[it.id] = it; });
      return map;
    }

    function mergeList(kind) {
      var lMap = indexBy(local[kind]);
      var rMap = indexBy(remote[kind]);
      var bMap = base[kind] || {};
      var ids = {};
      var n;

      for (n in lMap) ids[n] = 1;
      for (n in rMap) ids[n] = 1;

      var out = [];

      Object.keys(ids).forEach(function (id) {
        var l = lMap[id];
        var r = rMap[id];
        var b = bMap[id];
        var t = Math.max(l ? (l.updatedAt || l.createdAt || 0) : 0,
          r ? (r.updatedAt || r.createdAt || 0) : 0);

        if (deleted[id] && deleted[id] > t) return;   // 删掉的不再拉回来

        if (!l) { out.push(r); return; }
        if (!r) { out.push(l); return; }

        // 没见过祖先：只能按时间，后写的赢
        if (!b) {
          out.push((r.updatedAt || 0) > (l.updatedAt || 0) ? r : l);
          return;
        }

        var merged = {};
        var clash = [];
        var fields = {};
        var f;

        for (f in l) fields[f] = 1;
        for (f in r) fields[f] = 1;
        for (f in b) fields[f] = 1;

        Object.keys(fields).forEach(function (f2) {
          if (IMG_FIELDS[f2] || META_FIELDS[f2]) return;    // 大图和记账字段不参与合并

          var lv = l[f2];
          var rv = r[f2];
          var bv = b[f2];

          if (sameVal(lv, rv)) { merged[f2] = lv; return; }
          if (sameVal(lv, bv)) { merged[f2] = rv; return; }   // 只有另一台改过
          if (sameVal(rv, bv)) { merged[f2] = lv; return; }   // 只有本机改过

          // 两边都动了同一个字段
          clash.push(f2);
          merged[f2] = lv;
        });

        merged.id = id;
        merged.createdAt = l.createdAt || r.createdAt || Date.now();
        if (l.imgLite || r.imgLite) merged.imgLite = 1;
        merged.updatedAt = Math.max(l.updatedAt || 0, r.updatedAt || 0) || Date.now();

        if (clash.length) {
          conflicts.push({
            kind: kind,
            id: id,
            title: r.title || l.title || "（没标题）",
            fields: clash
          });

          // 另一台的版本原样留一份，谁也不丢
          var copy = {};
          var cf;
          for (cf in r) copy[cf] = r[cf];

          copy.id = uid();
          copy.title = (r.title || l.title || "未命名") + "（另一台设备改的）";
          copy.createdAt = r.createdAt || Date.now();
          copy.updatedAt = Date.now();
          copy.conflictOf = id;

          out.push(copy);
        }

        out.push(merged);
      });

      return out;
    }

    return {
      app: "fish-study",
      version: 1,
      updatedAt: Date.now(),
      items: mergeList("items"),
      summaries: mergeList("summaries"),
      memos: mergeList("memos"),
      deleted: deleted,
      conflicts: conflicts
    };
  }

  async function applyData(data) {
    var keep = {};
    var items = data.items || [];
    var i, j;

    // 图片只在本地存着，同步回来的记录没图，就接着用本机原来那张
    var imgMap = {};
    var oldLocal = await dbGetAll();

    for (i = 0; i < oldLocal.length; i++) {
      if (oldLocal[i].image) {
        imgMap[oldLocal[i].id] = {
          image: oldLocal[i].image,
          imageCrop: oldLocal[i].imageCrop || ""
        };
      }
    }

    for (i = 0; i < items.length; i++) {
      keep[items[i].id] = 1;

      var img = imgMap[items[i].id];
      if (img && !items[i].image) {
        items[i].image = img.image;
        items[i].imageCrop = img.imageCrop;
      }

      await dbPut(items[i]);
    }

    var local = await dbGetAll();
    for (j = 0; j < local.length; j++) {
      if (!keep[local[j].id]) await dbDelete(local[j].id);
    }

    var keepS = {};
    var summaries = data.summaries || [];

    var imgMapS = {};
    var oldS = await dbGetAll(SUM_STORE);

    for (i = 0; i < oldS.length; i++) {
      if (oldS[i].image || (Array.isArray(oldS[i].images) && oldS[i].images.length)) {
        imgMapS[oldS[i].id] = {
          image: oldS[i].image || "",
          images: Array.isArray(oldS[i].images) ? oldS[i].images : [],
          sections: Array.isArray(oldS[i].sections) ? oldS[i].sections : []
        };
      }
    }

    for (i = 0; i < summaries.length; i++) {
      keepS[summaries[i].id] = 1;

      var imgs = imgMapS[summaries[i].id];
      if (imgs && !summaries[i].image) {
        summaries[i].image = imgs.image || imgs.images[0] || "";
        if (imgs.images.length) summaries[i].images = imgs.images;
      }

      // 分段里的原图也接回来（远端只有小图）
      if (imgs && imgs.sections.length && Array.isArray(summaries[i].sections)) {
        summaries[i].sections.forEach(function (sec, n) {
          var local = imgs.sections[n];
          if (local && local.image && !sec.image) sec.image = local.image;
        });
      }

      await dbPut(summaries[i], SUM_STORE);
    }

    var localS = await dbGetAll(SUM_STORE);
    for (j = 0; j < localS.length; j++) {
      if (!keepS[localS[j].id]) await dbDelete(localS[j].id, SUM_STORE);
    }

    var keepM = {};
    var memos = data.memos || [];

    for (i = 0; i < memos.length; i++) {
      keepM[memos[i].id] = 1;
      await dbPut(memos[i], MEMO_STORE);
    }

    var localM = await dbGetAll(MEMO_STORE);
    for (j = 0; j < localM.length; j++) {
      if (!keepM[localM[j].id]) await dbDelete(localM[j].id, MEMO_STORE);
    }

    saveDeleted(data.deleted || {});
    await reload();
    await loadSavedSummaries();
    await loadMemos();
  }

  async function syncNow(silent) {
    var s = loadSync();

    if (!s.token) {
      setSyncStatus("先填一个 token", "err");
      return;
    }

    if (!silent) setSyncStatus("正在同步…");

    try {
      await ensureGist();

      var remote = await readGist();
      var local = {
        items: state.items,
        summaries: sum.saved,
        memos: state.memos,
        deleted: loadDeleted()
      };

      var merged = mergeData(local, remote);

      await writeGist(merged);
      await applyData(merged);

      // 这次之后两边是一致的，记下来当下次合并的共同祖先
      saveBase(baseSnapshot(merged));

      var clash = (merged.conflicts || []).length;
      var when = new Date().toLocaleTimeString("zh-CN");

      if (clash) {
        setSyncStatus("同步好了 · " + clash + " 处两边都改过，另一台的版本已另存副本 · " + when, "ok");
        toast("同步好了，有 " + clash + " 条撞车，给你留了副本（标题带「另一台设备改的」）");
      } else {
        setSyncStatus("同步好了 · " + when, "ok");
        if (!silent) toast("同步好了");
      }
    } catch (err) {
      setSyncStatus("同步失败：" + err.message, "err");
    }
  }

  /* ---------------- 备忘录 ---------------- */

  var memoState = { editingId: null, query: "", filter: "all" };

  function fmtDateTime(ts) {
    var d = new Date(ts || Date.now());
    var p = function (n) { return String(n).padStart(2, "0"); };
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  function pad2(n) { return String(n).padStart(2, "0"); }

  // timestamp -> <input type="datetime-local"> 要的本地格式
  function toLocalInput(ts) {
    var d = new Date(ts || Date.now());
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
      "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function parseWhen(v) {
    if (!v) return 0;
    var t = new Date(v).getTime();
    return isNaN(t) ? 0 : t;
  }

  // 卡片上显示的时间：今天/明天/后天 + 几点
  function fmtWhen(ts) {
    if (!ts) return "";
    var d = new Date(ts);
    var now = new Date();
    var dayOf = function (x) { return new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime(); };
    var diff = Math.round((dayOf(d) - dayOf(now)) / 86400000);
    var hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
    var sameYear = d.getFullYear() === now.getFullYear();

    if (diff === 0) return "今天 " + hm;
    if (diff === 1) return "明天 " + hm;
    if (diff === 2) return "后天 " + hm;
    if (diff === -1) return "昨天 " + hm;
    if (diff < -1) return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
    if (sameYear) return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + hm;
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " + hm;
  }

  // 取一条备忘的"安排时间"，老数据没填就用创建时间兜底
  function memoWhenOf(m) {
    return m.when || m.createdAt || 0;
  }

  async function loadMemos() {
    state.memos = await dbGetAll(MEMO_STORE);
    sortMemos();
    renderMemos();
  }

  // 待办按定好的时间从早到晚，已完成的沉底按完成时间倒序
  function sortMemos() {
    state.memos.sort(function (a, b) {
      if (!!a.done !== !!b.done) return a.done ? 1 : -1;
      if (a.done) return (b.doneAt || 0) - (a.doneAt || 0);
      return memoWhenOf(a) - memoWhenOf(b);
    });
  }

  async function toggleMemoDone(id) {
    var m = state.memos.find(function (x) { return x.id === id; });
    if (!m) return;

    m.done = !m.done;
    m.doneAt = m.done ? Date.now() : 0;
    m.updatedAt = Date.now();

    await dbPut(m, MEMO_STORE);
    sortMemos();
    renderMemos();

    toast(m.done ? "完成啦 ✓" : "又变回待办了");

    var s = loadSync();
    if (s.token && s.gistId) syncNow(true);
  }

  function renderMemos() {
    var listEl = $("memoList");
    var emptyEl = $("memoEmpty");
    if (!listEl || !emptyEl) return;

    var q = (memoState.query || "").trim().toLowerCase();
    var shown = state.memos.filter(function (m) {
      if (memoState.filter === "todo" && m.done) return false;
      if (memoState.filter === "done" && !m.done) return false;
      if (!q) return true;
      return ((m.title || "") + " " + (m.body || "")).toLowerCase().indexOf(q) >= 0;
    });

    if (!state.memos.length) {
      listEl.innerHTML = "";
      emptyEl.classList.add("show");
      return;
    }

    emptyEl.classList.remove("show");

    if (!shown.length) {
      var msg = memoState.filter === "done" ? "还没有完成的事项"
        : memoState.filter === "todo" ? "待办都清空啦 🎉"
          : "没搜到，换个词试试";
      listEl.innerHTML =
        '<div class="stat-hint" style="grid-column:1/-1;padding:40px 0;text-align:center">' +
        msg + "</div>";
      return;
    }

    listEl.innerHTML = shown.map(function (m) {
      var t = (m.title || "").trim();
      var done = !!m.done;

      var title = t
        ? '<div class="memo-card__title">' + escapeHtml(t) + "</div>"
        : '<div class="memo-card__title is-empty">（没写标题）</div>';

      var body = (m.body || "").trim();
      var preview = '<div class="memo-card__body">' +
        (body ? escapeHtml(body.slice(0, 220)) : "") + "</div>";

      var whenTs = memoWhenOf(m);
      var overdue = !done && whenTs && whenTs < Date.now();
      var whenChip = whenTs
        ? '<div class="memo-card__when' + (overdue ? " is-overdue" : "") + '">🕒 ' +
          escapeHtml(fmtWhen(whenTs)) + (overdue ? " · 已过期" : "") + "</div>"
        : "";

      return '<article class="memo-card' + (done ? " is-done" : "") + '" data-id="' + m.id + '">' +
        '<button type="button" class="memo-card__check" data-id="' + m.id + '" title="' +
        (done ? "标回待办" : "标记完成") + '">✓</button>' +
        title + preview + whenChip +
        '<div class="memo-card__date">' + fmtDateTime(done && m.doneAt ? m.doneAt : (m.updatedAt || m.createdAt)) +
        (done ? " · 已完成" : "") + "</div>" +
        "</article>";
    }).join("");

    listEl.querySelectorAll(".memo-card").forEach(function (card) {
      card.addEventListener("click", function () { openMemo(card.dataset.id); });
    });

    listEl.querySelectorAll(".memo-card__check").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleMemoDone(btn.dataset.id);
      });
    });
  }

  function openMemo(id) {
    var m = id ? state.memos.find(function (x) { return x.id === id; }) : null;

    memoState.editingId = m ? m.id : null;

    $("memoDrawerTitle").textContent = m ? "编辑备忘" : "写一条备忘录";
    $("memoTitle").value = m ? (m.title || "") : "";
    $("memoBody").value = m ? (m.body || "") : "";
    $("memoDelete").hidden = !m;

    var whenEl = $("memoWhen");
    if (whenEl) whenEl.value = m ? toLocalInput(memoWhenOf(m)) : toLocalInput(Date.now());

    var meta = $("memoMeta");
    if (m) {
      meta.textContent = "创建于 " + fmtDateTime(m.createdAt) +
        (m.updatedAt && m.updatedAt !== m.createdAt ? " · 改于 " + fmtDateTime(m.updatedAt) : "");
    } else {
      meta.textContent = "先存在这台电脑上，连了同步才会跨设备";
    }

    $("memoDrawer").classList.add("open");
    $("memoDrawer").setAttribute("aria-hidden", "false");

    setTimeout(function () {
      var el = $("memoTitle");
      if (el) el.focus();
    }, 30);
  }

  function closeMemo() {
    var el = $("memoDrawer");
    if (!el) return;
    el.classList.remove("open");
    el.setAttribute("aria-hidden", "true");
    memoState.editingId = null;
  }

  async function saveMemo() {
    var title = $("memoTitle").value.trim();
    var body = $("memoBody").value.trim();
    var whenEl = $("memoWhen");
    var when = whenEl ? parseWhen(whenEl.value) : 0;

    if (!title && !body) {
      toast("空白的，先写点啥");
      return;
    }

    var now = Date.now();
    var m = memoState.editingId
      ? state.memos.find(function (x) { return x.id === memoState.editingId; })
      : null;

    if (m) {
      m.title = title;
      m.body = body;
      m.when = when || m.when || m.createdAt || now;
      m.updatedAt = now;
    } else {
      m = {
        id: "memo-" + now.toString(36) + "-" + Math.random().toString(36).slice(2, 8),
        title: title,
        body: body,
        when: when || now,
        createdAt: now,
        updatedAt: now
      };
    }

    await dbPut(m, MEMO_STORE);
    closeMemo();
    await loadMemos();
    toast("存好了");

    var s = loadSync();
    if (s.token && s.gistId) syncNow(true);
  }

  async function deleteMemo() {
    if (!memoState.editingId) return;

    var id = memoState.editingId;
    var snapshot = null;
    var i;

    for (i = 0; i < state.memos.length; i++) {
      if (state.memos[i].id === id) { snapshot = state.memos[i]; break; }
    }

    await dbDelete(id, MEMO_STORE);
    markDeleted(id);
    closeMemo();
    await loadMemos();

    toast("备忘录删掉了", "撤销", async function () {
      if (!snapshot) return;
      unmarkDeleted(id);
      await dbPut(snapshot, MEMO_STORE);
      await loadMemos();
      toast("回来了");
    });

    syncSoon(7000);
  }

  /* ---------------- 视图切换 ---------------- */

  function switchView(name, remember) {
    state.view = name;

    document.querySelectorAll("#tabs .tab").forEach(function (t) {
      t.classList.toggle("is-active", t.dataset.view === name);
    });

    $("view-book").hidden = name !== "book";
    $("view-summary").hidden = name !== "summary";
    $("view-memo").hidden = name !== "memo";

    document.querySelectorAll("[data-book-only]").forEach(function (el) {
      el.hidden = name !== "book";
    });

    // 这两个按钮靠 class 控制，不走 hidden（窄屏那个还要跟媒体查询配合）
    ["btnFilter", "btnReview"].forEach(function (id) {
      var el = $(id);
      if (el) el.classList.toggle("is-off", name !== "book");
    });

    if (name !== "book") setFilterPanel(false);

    if (remember !== false) {
      try { localStorage.setItem("mistake-book.view", name); } catch (e) { /* 忽略 */ }
    }
  }

  // 恢复上次待的分区
  function restoreView() {
    var saved = null;
    try { saved = localStorage.getItem("mistake-book.view"); } catch (e) { /* 忽略 */ }
    if (saved === "summary" || saved === "memo") switchView(saved, false);
  }

  /* ---------------- 快捷键 ---------------- */

  function isTyping(el) {
    if (!el) return false;
    var tag = el.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
  }

  function isOpen(id) {
    var el = $(id);
    return !!(el && el.classList.contains("open"));
  }

  function bindShortcuts() {
    document.addEventListener("keydown", function (e) {
      var key = e.key;

      // Esc：按顺序关掉最上层的抽屉
      if (key === "Escape") {
        if ($("review").classList.contains("open")) { closeReview(); return; }
        if (isOpen("memoDrawer")) { closeMemo(); return; }
        if (isOpen("drawer")) { closeForm(); return; }
        if (isOpen("viewer")) { closeViewer(); return; }
        setFilterPanel(false);
      }

      // Ctrl/⌘ + Enter：保存当前抽屉
      if ((e.ctrlKey || e.metaKey) && key === "Enter") {
        if (isOpen("memoDrawer")) { e.preventDefault(); saveMemo(); return; }
        if (isOpen("drawer")) {
          e.preventDefault();
          var form = $("form");
          if (form && form.requestSubmit) form.requestSubmit();
          return;
        }
      }

      // / 或 Ctrl+K：跳到搜索框
      if (!isTyping(document.activeElement) &&
        (key === "/" || ((e.ctrlKey || e.metaKey) && key.toLowerCase() === "k"))) {
        var target = state.view === "memo" ? $("memoSearch")
          : state.view === "book" ? $("search") : null;
        if (target) {
          e.preventDefault();
          target.focus();
          if (target.select) target.select();
        }
      }
    });
  }

  /* ---------------- 启动 ---------------- */

  document.addEventListener("DOMContentLoaded", function () {
    bindEvents();
    bindShortcuts();
    placeSearch();
    restoreView();
    updateOcrHint();

    var maxTip = $("sumMaxTip");
    if (maxTip) maxTip.textContent = MAX_IMAGES;

    updateWalletUI();
    updateSyncUI();

    // 先把空状态画出来：读库慢或被浏览器卡住时，页面也不至于一片黑
    try { renderList(); } catch (e) { /* 忽略 */ }
    try { renderMemos(); } catch (e) { /* 忽略 */ }

    if (!("indexedDB" in window)) {
      toast("浏览器不支持本地存储，换 Chrome / Edge 试试");
      return;
    }

    var p1 = reload().catch(function (err) {
      console.error(err);
      toast("数据加载失败：" + err.message);
      // 读库失败也要把空状态画出来，别留一片黑
      try { renderList(); } catch (e) { /* 忽略 */ }
    });

    var p2 = loadSavedSummaries().catch(function (err) {
      console.error(err);
    });

    var p3 = loadMemos().catch(function (err) {
      console.error(err);
      try { renderMemos(); } catch (e) { /* 忽略 */ }
    });

    // 连过同步的话，打开就悄悄对一次
    Promise.all([p1, p2, p3]).then(function () {
      var s = loadSync();
      if (s.token && s.gistId) {
        setTimeout(function () { syncNow(true); }, 800);
      }
    });

    // 上次跑到一半的总结：把草稿捡起来挂个提示条
    loadDraftOnce().catch(function () { /* 没草稿也没关系 */ });

    // PDF 那个 worker 要走本地文件，别让它去 CDN 找
    if (window.pdfjsLib) {
      try { pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js"; } catch (e) { /* 忽略 */ }
    }

    // 占了多少地方
    updateStoreSize();

    // 加到桌面 / 断网也能开（file:// 下注册不了，跳过）
    registerSW();
  });

  async function loadDraftOnce() {
    try {
      var all = await dbGetAll(DRAFT_STORE);
      var d = (all || [])[0] || null;
      if (!d) { refreshDraftBar(); return; }

      sum.draft = d;
      refreshDraftBar();

      var left = (d.total || 0) - (d.done || []).length;
      if (left > 0) {
        sumStatus("上次跑到 " + (d.done || []).length + "/" + d.total +
          " 张，点「接着跑」把剩下的跑完", "err");
      }
    } catch (e) {
      refreshDraftBar();
    }
  }

  /* ---------------- 存储占用 ---------------- */

  function fmtBytes(n) {
    if (!n) return "0 MB";
    if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
    return (n / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function updateStoreSize() {
    var el = $("storeSize");
    if (!el) return;

    if (!navigator.storage || !navigator.storage.estimate) {
      el.textContent = "看不了";
      return;
    }

    navigator.storage.estimate().then(function (est) {
      var used = est && est.usage ? est.usage : 0;
      var quota = est && est.quota ? est.quota : 0;

      el.textContent = fmtBytes(used) + (quota ? " / " + fmtBytes(quota) : "");
      el.title = "浏览器给这个站的总空间 " + fmtBytes(quota) +
        "\n图片和总结都存在这里面";

      if (quota && used / quota > 0.8) {
        el.textContent = fmtBytes(used) + " · 快满了";
        el.style.color = "#ff8a8a";
      }
    }).catch(function () {
      el.textContent = "算不出来";
    });
  }

  /* ---------------- PWA ---------------- */

  function registerSW() {
    if (!("serviceWorker" in navigator)) return;
    if (location.protocol !== "http:" && location.protocol !== "https:") return;

    navigator.serviceWorker.register("sw.js").catch(function () {
      /* 注册不上就算了，本站不靠它也能用 */
    });
  }
})();
