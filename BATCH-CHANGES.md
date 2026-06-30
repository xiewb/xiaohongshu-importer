# 小红书导入器 — 批量下载 + 合集支持 完整修改方案

> **仓库**: https://github.com/xiewb/xiaohongshu-importer
> **版本**: 1.1.3 → 1.2.0
> **改动文件**: `main.ts`、`styles.css`、`manifest.json`

---

## 一、功能概览

| 功能 | 说明 | 状态 |
|------|------|------|
| 批量下载 | 从一段文本中自动提取所有小红书链接，逐条导入 | ✅ 已实现 |
| 批量限制配置 | 设置页可配置单次批量上限，默认 20 条 | ✅ 已实现 |
| 合集下载 | 粘贴合集链接，自动展开为逐条笔记并导入 | ✅ 已实现 |
| 进度反馈 | 导入过程中显示 `📥 Importing 3/10...` 进度通知 | ✅ 已实现 |
| 失败隔离 | 单条失败不阻断整批，最终汇总报告 | ✅ 已实现 |
| 限流保护 | 每条之间 1.5s 间隔，避免被反爬 | ✅ 已实现 |

---

## 二、架构设计

### 数据流

```
用户粘贴文本
  ↓
extractAllURLs(text)          ← 提取所有 URL（短链 + 笔记链接 + 合集链接）
  ↓
遍历 URL 列表：
  ├─ 普通笔记 URL → 直接加入 expandedUrls
  └─ 合集 URL → extractCollectionNoteIds(url) → 展开为 N 条笔记 URL
  ↓
检查 batchLimit 限制           ← 超出则截断并提示
  ↓
单条 → importXHSNote(url)
多条 → importBatch(urls)      ← 循环调用 importXHSNote + 进度 + 失败隔离
```

### 关键函数清单

| 函数 | 作用 | 改动类型 |
|------|------|---------|
| `extractAllURLs(text)` | 从文本中提取所有小红书 URL | **重写**（原 extractURL 只返回第一个） |
| `isCollectionUrl(url)` | 判断是否为合集链接 | **新增** |
| `extractCollectionNoteIds(url)` | 抓取合集页面，提取笔记 ID 列表 | **新增** |
| `importBatch(urls, ...)` | 批量导入 + 进度 + 失败隔离 | **新增** |
| `importXHSNote(url, ...)` | 单条导入（原有逻辑不变） | 不变 |
| `handleImport()` | 主流程：提取→展开→限制→导入 | **重写** |

---

## 三、改动详情

### 改动 1：Settings 接口 + 默认值

**文件**: `main.ts` 第 3-15 行

```typescript
interface XHSImporterSettings {
  defaultFolder: string;
  categories: string[];
  lastCategory: string;
  downloadMedia: boolean;
  batchLimit: number;  // ← 新增：批量下载上限
}

const DEFAULT_SETTINGS: XHSImporterSettings = {
  defaultFolder: "XHS Notes",
  categories: ["美食", "旅行", "娱乐", "知识", "工作", "情感", "个人成长", "优惠", "搞笑", "育儿"],
  lastCategory: "",
  downloadMedia: false,
  batchLimit: 20,  // ← 新增：默认 20 条
};
```

### 改动 2：extractAllURLs — 支持 3 种 URL 类型

**文件**: `main.ts` 第 104-138 行

```typescript
extractAllURLs(shareText: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  // 1. 移动端短链 (xhslink.com)
  const shortRegex = /https?:\/\/xhslink\.com\/a?o?\/[^\s,，]+/g;
  for (const match of shareText.matchAll(shortRegex)) {
    if (!seen.has(match[0])) { seen.add(match[0]); urls.push(match[0]); }
  }

  // 2. 合集链接 (xiaohongshu.com/collection/item/)
  const collectionRegex = /https?:\/\/(?:www\.)?xiaohongshu\.com\/collection\/item\/[a-zA-Z0-9]+(?:\?[^\s,，]*)?/g;
  for (const match of shareText.matchAll(collectionRegex)) {
    if (!seen.has(match[0])) { seen.add(match[0]); urls.push(match[0]); }
  }

  // 3. 桌面端笔记链接 (discovery/item + explore)
  const longRegex = /https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^\s,，]*)?/g;
  for (const match of shareText.matchAll(longRegex)) {
    const normalized = match[0].replace('/explore/', '/discovery/item/');
    if (!seen.has(normalized)) { seen.add(normalized); urls.push(normalized); }
  }

  return urls;
}
```

### 改动 3：isCollectionUrl — 合集 URL 检测

**文件**: `main.ts` 新增方法

```typescript
isCollectionUrl(url: string): boolean {
  return /xiaohongshu\.com\/collection\/item\//.test(url);
}
```

### 改动 4：extractCollectionNoteIds — 合集笔记提取

**文件**: `main.ts` 新增方法

```typescript
async extractCollectionNoteIds(collectionUrl: string): Promise<{
  name: string;
  noteIds: string[];
  totalNotes: number;
}> {
  const response = await requestUrl({ url: collectionUrl });
  const html = response.text;
  const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
  if (!stateMatch) throw new Error("Failed to parse collection page");

  const cleanedJson = stateMatch[1].trim().replace(/undefined/g, "null");
  const state = JSON.parse(cleanedJson);
  const collectionData = state.noteData?.collectionData;
  if (!collectionData || !collectionData.noteList) {
    throw new Error("Failed to parse collection data");
  }

  return {
    name: collectionData.name || "Unknown Collection",
    noteIds: collectionData.noteList.map((note: any) => note.id),
    totalNotes: collectionData.noteNum || collectionData.noteList.length,
  };
}
```

**数据来源验证**（实测合集 `69e8c40f0475000000000001`）:
```
__INITIAL_STATE__.noteData.collectionData = {
  name: "Claude Code大赏",
  noteNum: 18,           // 合集总笔记数
  noteList: [            // 首次加载的笔记（最多 10 条）
    { id: "69eb11e60000000020013002", title: "解密Claude Code...", type: "video" },
    // ... 共 10 条
  ]
}
```

**限制**: 首次加载最多 10 条，超出部分需分页 API（当前未实现）。

### 改动 5：importBatch — 批量导入

**文件**: `main.ts` 新增方法

```typescript
async importBatch(urls: string[], category: string, downloadMedia: boolean) {
  const total = urls.length;
  let success = 0;
  const failedUrls: string[] = [];
  const progressNotice = new Notice(`📥 Importing 0/${total}...`, 0);

  for (let i = 0; i < total; i++) {
    progressNotice.setMessage(`📥 Importing ${i + 1}/${total}...`);
    try {
      await this.importXHSNote(urls[i], category, downloadMedia);
      success++;
    } catch (e) {
      failedUrls.push(urls[i]);
      console.error(`Batch import failed [${i + 1}/${total}]: ${urls[i]} - ${e.message}`);
    }
    // 1.5s 间隔防限流
    if (i < total - 1) await new Promise((r) => setTimeout(r, 1500));
  }

  progressNotice.hide();

  if (failedUrls.length === 0) {
    new Notice(`✅ Batch import done: ${success}/${total} succeeded.`);
  } else {
    new Notice(`⚠️ Batch import done: ${success}/${total} succeeded, ${failedUrls.length} failed.`);
    console.log("Failed URLs:", failedUrls);
  }
}
```

### 改动 6：handleImport 主流程（含 batchLimit 限制）

**文件**: `main.ts` onload 中的 handleImport

```typescript
const handleImport = async () => {
  const input = await this.promptForShareText();
  if (input && input.text) {
    const urls = this.extractAllURLs(input.text);
    if (urls.length === 0) {
      new Notice("No valid Xiaohongshu URL found in the text.");
      return;
    }

    // 展开合集 URL → 逐条笔记 URL
    const expandedUrls: string[] = [];
    for (const url of urls) {
      if (this.isCollectionUrl(url)) {
        try {
          new Notice("📚 Fetching collection notes...");
          const collection = await this.extractCollectionNoteIds(url);
          new Notice(`📚 Collection "${collection.name}": ${collection.noteIds.length}/${collection.totalNotes} notes`);
          for (const noteId of collection.noteIds) {
            expandedUrls.push(`https://www.xiaohongshu.com/discovery/item/${noteId}`);
          }
          if (collection.totalNotes > collection.noteIds.length) {
            new Notice(`⚠️ Only ${collection.noteIds.length}/${collection.totalNotes} notes extracted (pagination limit).`);
          }
        } catch (e) {
          new Notice(`❌ Failed to fetch collection: ${e.message}`);
        }
      } else {
        expandedUrls.push(url);
      }
    }

    if (expandedUrls.length === 0) {
      new Notice("No valid notes to import after processing.");
      return;
    }

    // 应用批量限制
    if (expandedUrls.length > this.settings.batchLimit) {
      const count = expandedUrls.length;
      expandedUrls.length = this.settings.batchLimit;
      new Notice(`⚠️ Found ${count} URLs, limited to ${this.settings.batchLimit}. Adjust in settings.`);
    }

    if (expandedUrls.length === 1) {
      await this.importXHSNote(expandedUrls[0], input.category, input.downloadMedia);
    } else {
      new Notice(`Found ${expandedUrls.length} notes, starting batch import...`);
      await this.importBatch(expandedUrls, input.category, input.downloadMedia);
    }
  }
};
```

### 改动 7：设置页增加 Batch limit 配置

**文件**: `main.ts` XHSImporterSettingTab.display 方法中

```typescript
// 在 Download media toggle 之后添加
new Setting(containerEl)
  .setName("Batch limit")
  .setDesc("Maximum number of notes to import in a single batch operation (default: 20).")
  .addText((text) =>
    text
      .setPlaceholder("20")
      .setValue(String(this.plugin.settings.batchLimit))
      .onChange(async (value) => {
        const num = parseInt(value, 10);
        if (!isNaN(num) && num > 0) {
          this.plugin.settings.batchLimit = num;
          await this.plugin.saveSettings();
        }
      })
  );
```

### 改动 8：Modal UI 更新

**文件**: `main.ts` XHSInputModal.onOpen

```typescript
// 标题
"Import Xiaohongshu note(s)"

// placeholder
"Paste one or more share texts here...\nSupports: note URLs, share texts, collection URLs.\n\nExamples:\n64 不叫小黄了发布了一篇小红书笔记...\nhttps://www.xiaohongshu.com/explore/xxx\nhttps://www.xiaohongshu.com/collection/item/xxx"
```

### 改动 9：styles.css

```css
/* Text input (textarea) */
.xhs-modal-textarea {
  width: 100%;
  height: 160px;   /* 原 100px */
  margin: 0;
  resize: vertical; /* 新增：支持拖拽调整 */
}
```

---

## 四、使用场景

### 场景 1：从文本中批量提取链接

粘贴一段包含多个分享文本的内容：

```
415. 从黑箱到透明：18 个工具监控你的 Agent... http://xhslink.com/o/2Bmb2TBlCQy
416. Token压缩黑科技省95%... http://xhslink.com/o/NTdwtiyLho
417. 这次拆了一个很有意思的开源项目Headroom... http://xhslink.com/o/5d96FgdJ6Mr
```

→ 自动提取 3 个链接，逐条导入

### 场景 2：导入整个合集

```
https://www.xiaohongshu.com/collection/item/69e8c40f0475000000000001
```

→ 展开为 10 条笔记，逐条导入（合集共 18 条，受分页限制）

### 场景 3：混合场景 + 限制生效

粘贴 25 条链接（batchLimit=20）：

```
[25 条分享文本...]
```

→ 提取 25 条 → 截断为 20 条 → 提示 "⚠️ Found 25 URLs, limited to 20"

---

## 五、测试用例

| # | 场景 | 输入 | 预期输出 |
|---|------|------|---------|
| 1 | 单条短链 | `http://xhslink.com/o/2Bmb2TBlCQy` | 导入 1 条笔记 |
| 2 | 多条短链（5 条） | 用户提供的 5 条测试链接 | 导入 5 条笔记 |
| 3 | 合集链接 | `https://www.xiaohongshu.com/collection/item/69e8c40f0475000000000001` | 展开为 10 条，逐条导入 |
| 4 | 超出限制 | 25 条链接 + batchLimit=20 | 截断为 20 条 + 提示 |
| 5 | 混合输入 | 1 条合集 + 2 条短链 | 合集展开 + 短链合并后导入 |
| 6 | 无有效链接 | `"这是一段普通文本"` | 提示 "No valid URL found" |

---

## 六、已知限制

| 限制 | 说明 | 后续方案 |
|------|------|---------|
| 合集分页 | 首次只加载 10 条笔记，剩余需 API 分页 | 需研究小红书分页 API 或 Playwright 模拟滚动 |
| 反爬风险 | 大批量导入可能触发限流 | 1.5s 间隔 + 可配置化间隔时间 |
| 文件名冲突 | 同名笔记会覆盖 | 后续可加时间戳后缀 |
