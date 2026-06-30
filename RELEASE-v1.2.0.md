# Release v1.2.0

## 变更摘要

### 新功能
- **批量下载**: 从一段文本中自动提取所有小红书链接，逐条导入
- **合集下载**: 粘贴合集链接（`/collection/item/`），自动展开为逐条笔记
- **批量限制配置**: 设置页可配置单次批量上限，默认 20 条
- **进度反馈**: 导入过程中显示 `📥 Importing 3/10...` 进度通知
- **失败隔离**: 单条失败不阻断整批，最终汇总报告
- **限流保护**: 每条之间 1.5s 间隔，避免被反爬

### 改动文件
| 文件 | 改动 |
|------|------|
| `main.ts` | +175/-42 行，新增 extractAllURLs、isCollectionUrl、extractCollectionNoteIds、importBatch |
| `styles.css` | textarea 高度 100→160px，新增 resize: vertical |
| `manifest.json` | 版本 1.1.3 → 1.2.0 |
| `package.json` | 版本 1.1.3 → 1.2.0 |
| `versions.json` | 新增 1.2.0 条目 |
| `BATCH-CHANGES.md` | 新增完整修改方案文档 |

---

## 发布步骤

在 `E:\github-self\xiaohongshu-importer` 目录下执行：

```bash
# 1. 构建
npm install
npm run build

# 2. 提交
git add -A
git commit -m "feat: batch import, collection support, and batch limit config (v1.2.0)"

# 3. 打 tag
git tag v1.2.0

# 4. 推送
git push origin main --tags
```

## GitHub Release

推送后在 https://github.com/xiewb/xiaohongshu-importer/releases/new 创建 Release：
- **Tag**: v1.2.0
- **Title**: v1.2.0 — Batch Import & Collection Support
- **Description**: 复制本文件的「变更摘要」部分
- **Assets**: 上传 `main.js`、`manifest.json`、`styles.css`（构建产物）
