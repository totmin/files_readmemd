<!--
  - SPDX-FileCopyrightText: Matthieu Le Corre <matthieu.lecorre@univ-nantes.fr>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div class="markdown-body" v-html="renderedContent" /> <!-- eslint-disable-line -->
</template>

<script>

import asciidoctor from 'asciidoctor'
import logger from '../logger.js'

export default {
	name: 'AsciidocEngine',
	props: {
		content: {
			type: String,
			default: '',
		},
	},

	data() {
		return {
			renderedContent: '',
		}
	},

	watch: {
		async content() {
			this.renderedContent = await this.converter.convert(this.content)
		},

	},
	created() {
		this.converter = asciidoctor()
		logger.debug('AsciiDoc engine loaded')
	},
}
</script>
