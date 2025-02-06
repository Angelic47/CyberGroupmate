import OpenAI from "openai";

export class BotActionHelper {
	constructor(chatConfig, bot, ragHelper, stickerHelper, visionHelper) {
		this.chatConfig = chatConfig;
		this.bot = bot;
		this.ragHelper = ragHelper;
		this.stickerHelper = stickerHelper;
		this.visionHelper = visionHelper;
	}

	async sendText(chatId, content, log = true, processEmoji = true) {
		await this._sendMessage(chatId, content, null, log, processEmoji);
	}

	async sendReply(chatId, content, replyToMessageId, log = true, processEmoji = true) {
		await this._sendMessage(chatId, content, replyToMessageId, log, processEmoji);
	}

	async _sendMessage(chatId, content, replyToMessageId = null, log = true, processEmoji = true) {
		const messageOptions = replyToMessageId ? { reply_to_message_id: replyToMessageId } : {};

		if (!processEmoji || !this.stickerHelper.getAvailableEmojis().length) {
			// 如果不处理emoji或没有可用的emoji，直接发送完整文本
			await this.bot.sendMessage(chatId, content, messageOptions);
		} else {
			// 分割文本和emoji
			const segments = this.splitContentIntoSegments(content);
			let firstSegment = true;

			for (const segment of segments) {
				const currentOptions = firstSegment ? messageOptions : {};
				const isEmoji = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu.test(segment);

				if (isEmoji) {
					// 只处理可用的emoji
					if (this.stickerHelper.getAvailableEmojis().includes(segment)) {
						const sticker = this.stickerHelper.getRandomSticker(segment);
						if (sticker) {
							// 发送sticker
							await this.bot.sendSticker(chatId, sticker.file_id, currentOptions);

							// 获取或生成sticker描述
							let description = await this.ragHelper.getStickerDescription(
								sticker.file_unique_id,
								sticker.file_id
							);
							if (!description) {
								description = await this.visionHelper.analyzeSticker(sticker);
								await this.ragHelper.saveStickerDescription(
									sticker.file_unique_id,
									sticker.file_id,
									description,
									{ emoji: segment }
								);
							}

							// 记录sticker动作
							if (log) {
								const metadata = {
									sticker_file_id: sticker.file_id,
									description: description,
									...(replyToMessageId && {
										reply_to_message_id: replyToMessageId,
									}),
								};
								await this.ragHelper.saveAction(
									chatId,
									description,
									"sticker",
									metadata
								);
							}
						}
					}
					// 如果是不可用的emoji，直接跳过
				} else if (segment.trim()) {
					// 如果是普通文本且不为空，发送文本
					await this.bot.sendMessage(chatId, segment, currentOptions);

					if (log) {
						const type = replyToMessageId ? "reply" : "text";
						const metadata = replyToMessageId
							? { reply_to_message_id: replyToMessageId }
							: {};
						await this.ragHelper.saveAction(chatId, segment, type, metadata);
					}
				}
				firstSegment = false;
			}
		}

		if (this.chatConfig.debug) {
			console.log(replyToMessageId ? "发送回复：" : "发送文本：", content);
		}
	}

	async setTyping(chatId) {
		await this.bot.sendChatAction(chatId, "typing");
	}

	async saveAction(chatId, content, type, additionalMetadata = {}) {
		await this.ragHelper.saveAction(chatId, content, type, additionalMetadata);
	}

	async search(chatId, keyword) {
		const searchResults = await this.ragHelper.searchSimilarContent(chatId, keyword, {
			limit: 5,
			contentTypes: ["message", "reply"],
			withContext: 3,
		});
		return searchResults;
	}

	async googleSearch(query, num = 5) {
		const url = `https://www.googleapis.com/customsearch/v1?key=${
			this.chatConfig.google.apiKey
		}&cx=${this.chatConfig.google.cseId}&q=${encodeURIComponent(query)}&num=${num}`;

		try {
			const response = await fetch(url);
			const data = await response.json();

			if (data.items && data.items.length > 0) {
				return data.items.map((item) => ({
					title: item.title,
					link: item.link,
					snippet: item.snippet,
				}));
			}
			return [];
		} catch (error) {
			console.error("搜索出错:", error);
			return [];
		}
	}

	async updateMemory(messageId, updatePrompt) {
		try {
			// 构建系统提示词
			const systemPrompt = `你是一个记忆管理助手。你的任务是根据用户的指示来更新或创建记忆。
记忆应该是简洁、客观的描述，避免主观评价。
如果是创建新记忆，请直接输出新的记忆内容。
如果是更新现有记忆，请基于现有记忆进行修改。
直接输出最终的记忆内容，不需要其他解释。`;

			// 根据messageId从ragHelper中获取用户相关信息，从而获取用户ID
			const message = await this.ragHelper.getMessage(messageId);
			const userId = message.metadata?.from?.id;
			if (!userId) {
				throw new Error("无法获取用户ID");
			}
			// 获取现有记忆
			const memoryRecord = await this.ragHelper.getUserMemory(userId);
			let currentMemory = memoryRecord ? memoryRecord.text : null;

			// 准备提示词
			let prompt;
			if (currentMemory) {
				prompt = `现有记忆：${currentMemory}\n\n记忆相关聊天记录：${message.text}\n\n更新记忆要求：${updatePrompt}`;
			} else {
				prompt = `记忆相关聊天记录：${message.text}\n\n创建记忆要求：${updatePrompt}`;
			}

			// 调用 GPT-4 生成新记忆
			const openai = new OpenAI({
				apiKey: this.chatConfig.secondaryLLM.backend.apiKey,
				baseURL: this.chatConfig.secondaryLLM.backend.baseURL,
			});
			const completion = await openai.chat.completions.create({
				model: this.chatConfig.secondaryLLM.backend.model,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: prompt },
				],
				temperature: 0.7,
			});

			const newMemory = completion.choices[0].message.content.trim();

			// 更新记忆
			const success = await this.ragHelper.updateUserMemory(userId, newMemory);

			if (this.chatConfig.debug) {
				console.log("更新用户" + userId + "的记忆：", newMemory);
			}

			if (success) {
				return {
					success: true,
					memory: newMemory,
					isNew: !currentMemory,
				};
			} else {
				throw new Error("RAG后端更新失败");
			}
		} catch (error) {
			console.error("更新用户记忆错误:", error);
			return {
				success: false,
				error: error.message,
			};
		}
	}

	// 辅助方法：将文本分割成普通文本和emoji的数组
	splitContentIntoSegments(content) {
		const segments = [];
		let currentText = "";

		// 使用正则表达式匹配emoji
		// 这个正则表达式会匹配Unicode emoji
		const emojiRegex = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/gu;
		let lastIndex = 0;

		for (const match of content.matchAll(emojiRegex)) {
			// 添加emoji前的文本
			if (match.index > lastIndex) {
				currentText += content.slice(lastIndex, match.index);
			}

			// 如果有累积的文本，添加到segments
			if (currentText) {
				segments.push(currentText);
				currentText = "";
			}

			// 添加emoji
			segments.push(match[0]);
			lastIndex = match.index + match[0].length;
		}

		// 添加剩余的文本
		if (lastIndex < content.length) {
			currentText += content.slice(lastIndex);
		}
		if (currentText) {
			segments.push(currentText);
		}

		return segments;
	}
}
