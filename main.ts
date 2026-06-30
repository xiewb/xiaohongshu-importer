import { Plugin, Notice, Modal, requestUrl, PluginSettingTab, App, Setting, WorkspaceLeaf, TFile } from "obsidian";

interface XHSImporterSettings {
	defaultFolder: string;
	categories: string[]; // User-defined categories, excluding "其他"
	lastCategory: string;
	downloadMedia: boolean;
	batchLimit: number; // Maximum number of notes to import in a single batch
}

const DEFAULT_SETTINGS: XHSImporterSettings = {
	defaultFolder: "XHS Notes",
	categories: ["美食", "旅行", "娱乐", "知识", "工作", "情感", "个人成长", "优惠", "搞笑", "育儿"], // Removed "Others"
	lastCategory: "",
	downloadMedia: false,
	batchLimit: 20,
};

export default class XHSImporterPlugin extends Plugin {
	settings: XHSImporterSettings;

	// Plugin lifecycle: Load settings and register UI/command elements
	async onload() {
		await this.loadSettings();

		// Shared import handler for both ribbon and command
		const handleImport = async () => {
			const input = await this.promptForShareText();
			if (input && input.text) {
				const urls = this.extractAllURLs(input.text);
				if (urls.length === 0) {
					new Notice("No valid Xiaohongshu URL found in the text.");
					return;
				}

				// Expand collection URLs to individual note URLs
				const expandedUrls: string[] = [];
				for (const url of urls) {
					if (this.isCollectionUrl(url)) {
						try {
							new Notice("📚 Fetching collection notes...");
							const collection = await this.extractCollectionNoteIds(url);
							new Notice(`📚 Collection "${collection.name}": found ${collection.noteIds.length}/${collection.totalNotes} notes`);
							for (const noteId of collection.noteIds) {
								expandedUrls.push(`https://www.xiaohongshu.com/discovery/item/${noteId}`);
							}
							// Warn if there are more notes than we could extract
							if (collection.totalNotes > collection.noteIds.length) {
								new Notice(`⚠️ Collection has ${collection.totalNotes} notes but only ${collection.noteIds.length} could be extracted (pagination limit).`);
							}
						} catch (e) {
							new Notice(`❌ Failed to fetch collection: ${e.message}`);
							console.error("Collection fetch error:", e);
						}
					} else {
						expandedUrls.push(url);
					}
				}

				if (expandedUrls.length === 0) {
					new Notice("No valid notes to import after processing.");
					return;
				}

				// Apply batch limit
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

		// Add ribbon icon to trigger note import
		this.addRibbonIcon("book", "Import Xiaohongshu note(s)", handleImport);

		// Add command for importing notes via command palette
		this.addCommand({
			id: "import",
			name: "Import Xiaohongshu note(s)",
			callback: handleImport,
		});

		// Register settings tab
		this.addSettingTab(new XHSImporterSettingTab(this.app, this));
	}

	// Load plugin settings from storage
	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	// Save plugin settings to storage
	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Prompt user for share text and category via modal
	async promptForShareText(): Promise<{ text: string | null; category: string; downloadMedia: boolean } | null> {
		return new Promise((resolve) => {
			const modal = new XHSInputModal(this.app, this.settings, (result) => resolve(result));
			modal.open();
		});
	}

	// Extract all Xiaohongshu URLs from share text (supports batch + collection)
	extractAllURLs(shareText: string): string[] {
		const urls: string[] = [];
		const seen = new Set<string>();

		// Match mobile share links (xhslink.com)
		const shortRegex = /https?:\/\/xhslink\.com\/a?o?\/[^\s,，]+/g;
		for (const match of shareText.matchAll(shortRegex)) {
			if (!seen.has(match[0])) {
				seen.add(match[0]);
				urls.push(match[0]);
			}
		}

		// Match collection links (xiaohongshu.com/collection/item/)
		const collectionRegex = /https?:\/\/(?:www\.)?xiaohongshu\.com\/collection\/item\/[a-zA-Z0-9]+(?:\?[^\s,，]*)?/g;
		for (const match of shareText.matchAll(collectionRegex)) {
			if (!seen.has(match[0])) {
				seen.add(match[0]);
				urls.push(match[0]);
			}
		}

		// Match desktop/web links (xiaohongshu.com — discovery/item and explore)
		const longRegex = /https?:\/\/(?:www\.)?xiaohongshu\.com\/(?:discovery\/item|explore)\/[a-zA-Z0-9]+(?:\?[^\s,，]*)?/g;
		for (const match of shareText.matchAll(longRegex)) {
			const normalized = match[0].replace('/explore/', '/discovery/item/');
			if (!seen.has(normalized)) {
				seen.add(normalized);
				urls.push(normalized);
			}
		}

		return urls;
	}

	// Check if a URL is a collection URL
	isCollectionUrl(url: string): boolean {
		return /xiaohongshu\.com\/collection\/item\//.test(url);
	}

	// Extract note IDs from a collection page's __INITIAL_STATE__
	async extractCollectionNoteIds(collectionUrl: string): Promise<{ name: string; noteIds: string[]; totalNotes: number }> {
		const response = await requestUrl({ url: collectionUrl });
		const html = response.text;
		const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
		if (!stateMatch) throw new Error("Failed to parse collection page: __INITIAL_STATE__ not found");

		const cleanedJson = stateMatch[1].trim().replace(/undefined/g, "null");
		const state = JSON.parse(cleanedJson);
		const collectionData = state.noteData?.collectionData;
		if (!collectionData || !collectionData.noteList) {
			throw new Error("Failed to parse collection data from page");
		}

		const noteIds: string[] = collectionData.noteList.map((note: any) => note.id);
		return {
			name: collectionData.name || "Unknown Collection",
			noteIds,
			totalNotes: collectionData.noteNum || noteIds.length,
		};
	}

	// Sanitize title for media filenames, removing emojis and special characters
	sanitizeFilename(title: string): string {
		// Keep only alphanumeric, Chinese characters, spaces, and safe symbols (-, _)
		let sanitized = title.replace(/[^a-zA-Z0-9\u4e00-\u9fa5\s-_]/g, "").trim();
		sanitized = sanitized.replace(/\s+/g, "-");
		sanitized = sanitized.length > 0 ? sanitized : "Untitled";
		return sanitized.substring(0, 50); // Limit to 50 chars
	}

	// Download media file and save to vault
	async downloadMediaFile(url: string, folderPath: string, filename: string): Promise<string> {
		try {
			const response = await fetch(url);
			if (!response.ok) throw new Error(`HTTP error ${response.status}`);
			const blob = await response.blob();
			const arrayBuffer = await blob.arrayBuffer();
			const filePath = `${folderPath}/${filename}`;
			await this.app.vault.adapter.writeBinary(filePath, arrayBuffer);
			return filename; // Return filename for Markdown reference
		} catch (error) {
			console.log(`Failed to download media from ${url}: ${error.message}`);
			new Notice(`Failed to download media: ${error.message}`);
			return url; // Fallback to original URL
		}
	}

	// Batch import multiple Xiaohongshu notes with progress and error isolation
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
			// Rate limit: 1.5s delay between requests to avoid being blocked
			if (i < total - 1) {
				await new Promise((r) => setTimeout(r, 1500));
			}
		}

		progressNotice.hide();

		if (failedUrls.length === 0) {
			new Notice(`✅ Batch import done: ${success}/${total} succeeded.`);
		} else {
			new Notice(`⚠️ Batch import done: ${success}/${total} succeeded, ${failedUrls.length} failed. Check console for details.`);
			console.log("Failed URLs:", failedUrls);
		}
	}

	// Main function to import a Xiaohongshu note
	async importXHSNote(url: string, category: string, downloadMedia: boolean) {
		try {
			const response = await requestUrl({ url });
			const html = response.text;

			// Extract note details
			const title = this.extractTitle(html);
			const videoUrl = this.extractVideoUrl(html);
			const images = this.extractImages(html);
			const content = this.extractContent(html);
			const isVideo = this.isVideoNote(html);

			// Build frontmatter and initial Markdown
			const noteDate = new Date().toISOString().split("T")[0];
			const importedAt = new Date().toLocaleString();
			let markdown = `---
title: ${title}
source: ${url}
date: ${noteDate}
Imported At: ${importedAt}
category: ${category}
---
# ${title}\n\n`;

			// Define folder structure
			const baseFolder = this.settings.defaultFolder || "";
			const mediaFolder = `${baseFolder}/media`;
			const categoryFolder = category || "Uncategorized";
			const folderPath = baseFolder ? `${baseFolder}/${categoryFolder}` : categoryFolder;

			// Sanitize title for note filename (less strict)
			let safeTitle = title.replace(/[/\\?%*:|"<>]/g, "-").trim();
			safeTitle = safeTitle.length > 0 ? safeTitle : "Untitled";
			safeTitle = safeTitle.substring(0, 50);
			const filename = isVideo ? `[V]${safeTitle}` : safeTitle;
			const filePath = `${folderPath}/${filename}.md`;

			// Stricter sanitization for media filenames
			const mediaSafeTitle = this.sanitizeFilename(title);

			// Create folders if they don’t exist
			if (!await this.app.vault.adapter.exists(folderPath)) {
				await this.app.vault.createFolder(folderPath);
			}
			if (downloadMedia && !await this.app.vault.adapter.exists(mediaFolder)) {
				await this.app.vault.createFolder(mediaFolder);
			}

			// Handle video notes
			if (isVideo) {
				if (videoUrl) {
					let finalVideoUrl = videoUrl;
					if (downloadMedia) {
						const videoFilename = `${mediaSafeTitle}-${Date.now()}.mp4`;
						const downloadedFilename = await this.downloadMediaFile(videoUrl, mediaFolder, videoFilename);
						finalVideoUrl = downloadedFilename.startsWith("http") ? downloadedFilename : `../media/${downloadedFilename}`;
					}
					markdown += `<video controls src="${finalVideoUrl}" width="100%"></video>\n\n`;
				} else if (images.length > 0) {
					let finalImageUrl = images[0];
					if (downloadMedia) {
						const imageFilename = `${mediaSafeTitle}-0-${Date.now()}.jpg`; // Use index 0 to match later logic
						const downloadedFilename = await this.downloadMediaFile(images[0], mediaFolder, imageFilename);
						finalImageUrl = downloadedFilename.startsWith("http") ? downloadedFilename : `../media/${downloadedFilename}`;
					}
					markdown += `[![Cover Image](${finalImageUrl})](${url})\n\n`;
					new Notice("Video URL not found; using cover image as fallback.");
				}
				const cleanContent = content.replace(/#\S+/g, "").trim();
				markdown += `${cleanContent.split("\n").join("\n")}\n\n`;

				const tags = this.extractTags(content);
				if (tags.length > 0) {
					markdown += "```\n";
					markdown += tags.map((tag) => `#${tag}`).join(" ") + "\n";
					markdown += "```\n";
				}
			}
			// Handle non-video notes
			else {
				let downloadedImages: string[] = [];
				if (images.length > 0) {
					if (downloadMedia) {
						// Download all images, including the first one (which will be used as the cover)
						for (let i = 0; i < images.length; i++) {
							const imageFilename = `${mediaSafeTitle}-${i}-${Date.now()}.jpg`;
							const downloadedFilename = await this.downloadMediaFile(images[i], mediaFolder, imageFilename);
							const finalImageUrl = downloadedFilename.startsWith("http") ? downloadedFilename : `../media/${downloadedFilename}`;
							downloadedImages.push(finalImageUrl);
						}
					} else {
						downloadedImages = images;
					}

					// Use the first downloaded image as the cover image (no separate download for cover)
					markdown += `![Cover Image](${downloadedImages[0]})\n\n`;
				}

				const cleanContent = content.replace(/#[^#\s]*(?:\s+#[^#\s]*)*\s*/g, "").trim();
				markdown += `${cleanContent.split("\n").join("\n")}\n\n`;

				const tags = this.extractTags(content);
				if (tags.length > 0) {
					markdown += "```\n";
					markdown += tags.map((tag) => `#${tag}`).join(" ") + "\n";
					markdown += "```\n\n";
				}

				if (images.length > 0) {
					// Add all images (including the first one, which is already used as the cover)
					const imageMarkdown = downloadedImages.map((url) => `![Image](${url})`).join("\n");
					markdown += `${imageMarkdown}\n`;
				}
			}

			// Create and open the note
			const file = await this.app.vault.create(filePath, markdown);
			await this.app.workspace.getLeaf(true).openFile(file);

			// Update last used category
			this.settings.lastCategory = category;
			await this.saveSettings();

			new Notice(`Imported Xiaohongshu note as ${filePath}`);
		} catch (error) {
			console.log(`Failed to import note from ${url}: ${error.message}`);
			new Notice(`Failed to import note: ${error.message}`);
		}
	}

	// Extract note title from HTML
	extractTitle(html: string): string {
		const match = html.match(/<title>(.*?)<\/title>/);
		return match ? match[1].replace(" - 小红书", "") : "Untitled Xiaohongshu Note";
	}

	// Extract image URLs from note data
	extractImages(html: string): string[] {
		const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
		if (!stateMatch) return [];

		try {
			const jsonStr = stateMatch[1].trim();
			const cleanedJson = jsonStr.replace(/undefined/g, "null");
			const state = JSON.parse(cleanedJson);
			const noteId = Object.keys(state.note.noteDetailMap)[0];
			const imageList = state.note.noteDetailMap[noteId].note.imageList || [];
			return imageList
				.map((img: any) => img.urlDefault || "")
				.filter((url: string) => url && url.startsWith("http"));
		} catch (e) {
			console.log(`Failed to parse images: ${e.message}`);
			return [];
		}
	}

	// Extract video URL from note data
	extractVideoUrl(html: string): string | null {
		const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
		if (!stateMatch) return null;

		try {
			const jsonStr = stateMatch[1].trim();
			const cleanedJson = jsonStr.replace(/undefined/g, "null");
			const state = JSON.parse(cleanedJson);
			const noteId = Object.keys(state.note.noteDetailMap)[0];
			const noteData = state.note.noteDetailMap[noteId].note;
			const videoInfo = noteData.video;

			if (!videoInfo || !videoInfo.media || !videoInfo.media.stream) return null;

			if (videoInfo.media.stream.h264 && videoInfo.media.stream.h264.length > 0) {
				return videoInfo.media.stream.h264[0].masterUrl || null;
			}
			if (videoInfo.media.stream.h265 && videoInfo.media.stream.h265.length > 0) {
				return videoInfo.media.stream.h265[0].masterUrl || null;
			}
			return null;
		} catch (e) {
			console.log(`Failed to parse video URL: ${e.message}`);
			return null;
		}
	}

	// Extract note content from HTML or JSON
	extractContent(html: string): string {
		const divMatch = html.match(/<div id="detail-desc" class="desc">([\s\S]*?)<\/div>/);
		if (divMatch) {
			return divMatch[1]
				.replace(/<[^>]+>/g, "")
				.replace(/\[话题\]/g, "")
				.replace(/\[[^\]]+\]/g, "")
				.trim() || "Content not found";
		}

		const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
		if (stateMatch) {
			try {
				const jsonStr = stateMatch[1].trim();
				const cleanedJson = jsonStr.replace(/undefined/g, "null");
				const state = JSON.parse(cleanedJson);
				const noteId = Object.keys(state.note.noteDetailMap)[0];
				const desc = state.note.noteDetailMap[noteId].note.desc || "";
				return desc
					.replace(/\[话题\]/g, "")
					.replace(/\[[^\]]+\]/g, "")
					.trim() || "Content not found";
			} catch (e) {
				console.log(`Failed to parse content from JSON: ${e.message}`);
			}
		}
		return "Content not found";
	}

	// Determine if the note is a video note
	isVideoNote(html: string): boolean {
		const stateMatch = html.match(/window\.__INITIAL_STATE__=(.*?)<\/script>/s);
		if (!stateMatch) return false;

		try {
			const jsonStr = stateMatch[1].trim();
			const cleanedJson = jsonStr.replace(/undefined/g, "null");
			const state = JSON.parse(cleanedJson);
			const noteId = Object.keys(state.note.noteDetailMap)[0];
			const noteType = state.note.noteDetailMap[noteId].note.type;
			return noteType === "video";
		} catch (e) {
			console.log(`Failed to determine note type: ${e.message}`);
			return false;
		}
	}

	// Extract tags from content
	extractTags(content: string): string[] {
		const tagMatches = content.match(/#\S+/g) || [];
		return tagMatches.map((tag) => tag.replace("#", "").trim());
	}

	// Plugin lifecycle: Cleanup on unload (currently empty)
	onunload() {}
}

class XHSImporterSettingTab extends PluginSettingTab {
	plugin: XHSImporterPlugin;

	constructor(app: App, plugin: XHSImporterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Default folder setting
		new Setting(containerEl)
			.setName("Default folder")
			.setDesc("Base folder where category subfolders will be created (e.g., 'XHS Notes'). Leave empty for vault root.")
			.addText((text) =>
				text
					.setPlaceholder("XHS Notes")
					.setValue(this.plugin.settings.defaultFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		// Download media toggle
		new Setting(containerEl)
			.setName("Download media")
			.setDesc("Default setting: if enabled, images and videos will be downloaded locally to 'XHS Notes/media/'. Can be overridden per import.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.downloadMedia)
					.onChange(async (value) => {
						this.plugin.settings.downloadMedia = value;
						await this.plugin.saveSettings();
					})
			);

		// Batch limit setting
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

		// Category management
		new Setting(containerEl)
			.setName("Categories")
			.setHeading();

		containerEl.createEl("p", { text: "Add, edit, or remove categories for organizing notes. Use Up/Down to reorder." });

		this.plugin.settings.categories.forEach((category, index) => {
			const setting = new Setting(containerEl)
				.setName(`Category ${index + 1}`)
				.addText((text) =>
					text
						.setValue(category)
						.onChange(async (value) => {
							this.plugin.settings.categories[index] = value.trim();
							await this.plugin.saveSettings();
						})
				);

			setting.addButton((button) =>
				button
					.setIcon("arrow-up")
					.setTooltip("Move up")
					.setDisabled(index === 0)
					.onClick(async () => {
						if (index > 0) {
							[this.plugin.settings.categories[index], this.plugin.settings.categories[index - 1]] =
								[this.plugin.settings.categories[index - 1], this.plugin.settings.categories[index]];
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);

			setting.addButton((button) =>
				button
					.setIcon("arrow-down")
					.setTooltip("Move down")
					.setDisabled(index === this.plugin.settings.categories.length - 1)
					.onClick(async () => {
						if (index < this.plugin.settings.categories.length - 1) {
							[this.plugin.settings.categories[index], this.plugin.settings.categories[index + 1]] =
								[this.plugin.settings.categories[index + 1], this.plugin.settings.categories[index]];
							await this.plugin.saveSettings();
							this.display();
						}
					})
			);

			setting.addButton((button) =>
				button
					.setButtonText("Remove")
					.onClick(async () => {
						this.plugin.settings.categories.splice(index, 1);
						await this.plugin.saveSettings();
						this.display();
					})
			);
		});

		new Setting(containerEl)
			.addButton((button) =>
				button
					.setButtonText("Add category")
					.onClick(async () => {
						this.plugin.settings.categories.push("New Category");
						await this.plugin.saveSettings();
						this.display();
					})
			);
	}
}

// Modal for user input during import
class XHSInputModal extends Modal {
	result: { text: string | null; category: string; downloadMedia: boolean } | null = null;
	onSubmit: (result: { text: string | null; category: string; downloadMedia: boolean } | null) => void;
	settings: XHSImporterSettings;
	selectedCategory: string;
	downloadMedia: boolean;

	constructor(app: App, settings: XHSImporterSettings, onSubmit: (result: { text: string | null; category: string; downloadMedia: boolean } | null) => void) {
		super(app);
		this.settings = settings;
		this.onSubmit = onSubmit;
		this.selectedCategory = this.settings.lastCategory && this.settings.categories.includes(this.settings.lastCategory)
			? this.settings.lastCategory
			: this.settings.categories[0] || "其他";
		this.downloadMedia = this.settings.downloadMedia;
	}

	onOpen() {
		const { contentEl } = this;
		// Apply CSS class to modal content
		contentEl.addClass("xhs-modal-content");

		contentEl.createEl("h2", { text: "Import Xiaohongshu note(s)" });

		// Share text input (supports batch: multiple URLs or share texts)
		const textRow = contentEl.createEl("div", { cls: "xhs-modal-row" });
		textRow.createEl("p", { text: "Paste share text(s) below — supports multiple URLs for batch import:" });
		const input = textRow.createEl("textarea", {
			cls: "xhs-modal-textarea",
			attr: { placeholder: "Paste one or more share texts here...\nSupports: note URLs, share texts, collection URLs.\n\nExamples:\n64 不叫小黄了发布了一篇小红书笔记...\nhttps://www.xiaohongshu.com/explore/xxx\nhttps://www.xiaohongshu.com/collection/item/xxx" },
		});

		// Category selection
		const categoryRow = contentEl.createEl("div", { cls: "xhs-modal-row" });
		categoryRow.createEl("p", { text: "Select a category:" });
		const chipContainer = categoryRow.createEl("div", { cls: "xhs-chip-container" });

		// Helper function to update chip styles
		const updateChipStyles = () => {
			chipContainer.querySelectorAll("button").forEach((btn) => {
				if (btn.textContent === this.selectedCategory) {
					btn.classList.add("xhs-chip--selected");
				} else {
					btn.classList.remove("xhs-chip--selected");
				}
			});
		};

		// Add user-defined categories
		this.settings.categories.forEach((category) => {
			const chip = chipContainer.createEl("button", {
				text: category,
				cls: "xhs-chip",
			});
			if (category === this.selectedCategory) {
				chip.classList.add("xhs-chip--selected");
			}

			chip.addEventListener("click", () => {
				this.selectedCategory = category;
				updateChipStyles();
			});
		});

		// Add hardcoded "其他" category
		const otherChip = chipContainer.createEl("button", {
			text: "其他",
			cls: "xhs-chip",
		});
		if ("其他" === this.selectedCategory) {
			otherChip.classList.add("xhs-chip--selected");
		}

		otherChip.addEventListener("click", () => {
			this.selectedCategory = "其他";
			updateChipStyles();
		});

		// Download media option
		const downloadRow = contentEl.createEl("div", { cls: ["xhs-modal-row", "xhs-download-row"] });
		const downloadWrapper = downloadRow.createEl("div", { cls: "xhs-download-wrapper" });
		const checkboxId = "download-media-checkbox";
		const checkbox = downloadWrapper.createEl("input", { attr: { type: "checkbox", id: checkboxId } });
		checkbox.checked = this.downloadMedia;
		checkbox.addEventListener("change", () => {
			this.downloadMedia = checkbox.checked;
		});
		const label = downloadWrapper.createEl("label", {
			text: "Download media locally for this import",
			cls: "xhs-download-label",
			attr: { for: checkboxId },
		});

		// Submit button
		const buttonRow = contentEl.createEl("div", { cls: ["xhs-modal-row", "xhs-button-row"] });
		const submitButton = buttonRow.createEl("button", {
			text: "Import",
			cls: "xhs-submit-button",
		});

		submitButton.addEventListener("click", () => {
			this.result = { text: input.value.trim(), category: this.selectedCategory, downloadMedia: this.downloadMedia };
			this.close();
		});

		input.addEventListener("keypress", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.result = { text: input.value.trim(), category: this.selectedCategory, downloadMedia: this.downloadMedia };
				this.close();
			}
		});
	}

	onClose() {
		this.onSubmit(this.result);
	}
}
