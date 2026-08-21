<!--
  - SPDX-FileCopyrightText: Matthieu Le Corre <matthieu.lecorre@univ-nantes.fr>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->

<template>
	<div v-if="hasEngine" :class="[ zone ]" :data-filename="fileName">
		<MarkdownEngine v-if="engineType == 'markdown'"
			:content="content"
			:mode="mode"
			:path="path" />
		<HtmlEngine v-if="engineType == 'html'" :content="content" />
		<AsciidocEngine v-if="engineType == 'asciidoc'" :content="content" />
	</div>
</template>

<script>
import MarkdownEngine from '../components/MarkdownEngine.vue'
import HtmlEngine from '../components/HtmlEngine.vue'
import AsciidocEngine from '../components/AsciidocEngine.vue'
import axios from '@nextcloud/axios'
import { generateUrl } from '@nextcloud/router'
import logger from '../logger.js'
import { loadState } from '@nextcloud/initial-state'

export default {
	name: 'Readmemd',

	components: {
		MarkdownEngine,
		HtmlEngine,
		AsciidocEngine,
	},

	data() {
		return {
			config: loadState('files_readmemd', 'config'),
			fileName: null,
			fileTableView: {},
			path: null,
			content: null,
			requestId: 0,
		}
	},

	computed: {
		engineType() {
			if (this.fileName === null || this.fileName === undefined) {
				return null
			}
			const ext = this.fileName.substr(this.fileName.lastIndexOf('.') + 1)
			if ((ext === 'html' || ext === 'htm') && this.config.show_html === 'true') { return 'html' }
			if ((ext === 'adoc' || ext === 'asciidoc') && this.config.show_asciidoc === 'true') { return 'asciidoc' }
			if (ext === 'md' || ext === 'markdown') { return 'markdown' }
			return null
		},

		hasEngine() {
			return this.engineType !== null
		},

		fileList() {
			const baseNames = this.zone === 'footermd' ? this.config.fileslist_footer : this.config.fileslist_header
			const names = []
			baseNames.forEach((fn) => {
				// Accept both bare basenames ("README") and full filenames
				// ("README.md" / ".README.markdown") as configured in the admin settings.
				Array.prototype.push.apply(names, [
					fn,
					'.' + fn,
					fn + '.md',
					'.' + fn + '.md',
					fn + '.markdown',
					'.' + fn + '.markdown',
				])

				if (this.config.show_asciidoc === 'true') {
					Array.prototype.push.apply(names, [
						fn + '.adoc',
						fn + '.asciidoc',
						'.' + fn + '.adoc',
						'.' + fn + '.asciidoc',
					])
				}

				if (this.config.show_html === 'true') {
					Array.prototype.push.apply(names, [
						fn + '.htm',
						fn + '.html',
						'.' + fn + '.htm',
						'.' + fn + '.html',
					])
				}
			})
			return names
		},

		mode() {
			// On Nextcloud >= 30 the public share page is provided through the
			// files app and exposes its state via the files_sharing app.
			return loadState('files_sharing', 'isPublic', false) ? 'public' : 'private'
		},

	},

	watch: {
		async path() {
			await this.refresh()
		},
	},

	async mounted() {
		await this.refresh()
	},

	methods: {
		async refresh() {
			// Guard against out-of-order responses when the folder changes
			// faster than the (slow) content fetch resolves.
			const requestId = ++this.requestId
			logger.debug('[' + this.zone + '] Refreshing for path ' + this.path)

			if (!this.path) {
				return
			}

			try {
				this.fileName = null
				const elected = await this.getElectedFileName()

				let content = null
				if (elected !== null && elected !== undefined) {
					logger.debug('[' + this.zone + '] File elected : ' + elected + ' for path ' + this.path)
					content = await this.getFile(elected)
				} else {
					logger.debug('[' + this.zone + '] No File elected : for path ' + this.path)
				}

				if (requestId === this.requestId) {
					this.fileName = elected
					this.content = content
				}
			} catch (error) {
				logger.error('[' + this.zone + '] Failed to load content for path ' + this.path, { error })
				if (requestId === this.requestId) {
					this.fileName = null
					this.content = null
				}
			}
		},

		async getElectedFileName() {
			const { contents } = await this.fileTableView.getContents(this.path)
			const FL = contents
				.filter((file) => file.type === 'file')
				.map((file) => file.basename)

			let result

			for (const activFile in this.fileList) {
				for (const filenum in FL) {
					if (FL[filenum] === this.fileList[activFile]) {
						result = FL[filenum]
					}
				}
			}
			return result
		},

		async getFile(fileName) {
			let URL

			if (this.mode === 'public') {
				const token = loadState('files_sharing', 'sharingToken')

				URL = generateUrl('/s/{token}/download?path={path}&files={file}',
					{
						token,
						path: this.path,
						file: fileName,
					},
				)
			} else {
				const dir = this.path.replace('?', '%3F')
				const fname = fileName.replace('?', '%3F')
				URL = OC.linkToRemoteBase('files' + dir + '/' + fname)
			}

			const response = await axios.get(URL)
			return response.data
		},
	},
}

</script>
