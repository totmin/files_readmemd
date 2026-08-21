<!--
  - SPDX-FileCopyrightText: Matthieu Le Corre <matthieu.lecorre@univ-nantes.fr>
  - SPDX-License-Identifier: AGPL-3.0-or-later
-->
<template>
	<div ref="container" class="markdown-body" v-html="renderedContent" /> <!-- eslint-disable-line -->
</template>

<script>
import { generateUrl } from '@nextcloud/router'
import { loadState } from '@nextcloud/initial-state'
import logger from '../logger.js'
import markdownit from 'markdown-it'
import markdownitcontainer from 'markdown-it-container'
import markdownittasklist from 'markdown-it-task-lists'
import implicitFigures from 'markdown-it-image-figures'
import markdownitimsize from 'markdown-it-imsize'
import markdownitanchor from 'markdown-it-anchor'
import markdownittocdoneright from 'markdown-it-toc-done-right'
import markdownitreplacelink from 'markdown-it-replace-link'
import { full as markdownitemoji } from 'markdown-it-emoji'

const ICON_COPY = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h6.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 8.75 15h-7A1.75 1.75 0 0 1 0 13.25v-6.5Z"/><path fill="currentColor" d="M4 6.75c0-1.036.784-1.875 1.75-1.875h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v6.5c0 .138.112.25.25.25h1.5a.75.75 0 0 1 0 1.5h-1.5A1.75 1.75 0 0 1 4 13.25v-6.5Z"/><path fill="currentColor" d="M6 3.75c0-1.036.784-1.875 1.75-1.875h5.5C14.216 1.875 15 2.714 15 3.75v5.5A1.75 1.75 0 0 1 13.25 11h-5.5A1.75 1.75 0 0 1 6 9.25v-5.5Z"/></svg>'

const ICON_CHECK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>'

/** Map the NC palette to the mermaid themeVariables. */
const MERMAID_THEME_VARS = {
	background: '--color-main-background',
	primaryTextColor: '--color-main-text',
	textColor: '--color-main-text',
	noteTextColor: '--color-main-text',
	primaryColor: '--color-background-hover',
	mainBkg: '--color-background-hover',
	nodeBkg: '--color-background-hover',
	actorBkg: '--color-background-hover',
	primaryBorderColor: '--color-border',
	clusterBorder: '--color-border',
	lineColor: '--color-text-maxcontrast',
	secondaryColor: '--color-background-dark',
	noteBkgColor: '--color-background-dark',
	tertiaryColor: '--color-main-background',
	labelBackground: '--color-main-background',
	edgeLabelBackground: '--color-main-background',
	clusterBkg: '--color-main-background',
}

/** Shared mermaid bundle (lazy, ~2 MB — kept out of the startup chunk). */
let mermaidPromise = null
/** Single viewport observer shared by every rendered markdown container. */
let mermaidObserver = null
/** Containers currently observed for lazy mermaid rendering. */
const observedMermaidContainers = new Set()
/** MutationObserver re-rendering visible diagrams when the NC theme flips. */
let mermaidThemeWatcher = null
/** Theme the current mermaid config was initialised for. */
let mermaidConfigThemeKey = ''
/** Unique id generator for mermaid.render (ids must be unique in the document). */
let mermaidDiagramId = 0

/**
 * Parse a CSS color string (#hex / #rgb / rgb() / rgba()) to [r, g, b].
 *
 * @param {string} color the CSS color
 * @return {number[]|null} RGB components or null when unparsable
 */
function parseCssColor(color) {
	const m = color.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
	if (m) {
		return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
	}
	const hex = color.replace('#', '')
	if (/^[0-9a-fA-F]{6}$/.test(hex)) {
		return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
	}
	if (/^[0-9a-fA-F]{3}$/.test(hex)) {
		return [parseInt(hex[0] + hex[0], 16), parseInt(hex[1] + hex[1], 16), parseInt(hex[2] + hex[2], 16)]
	}
	return null
}

/**
 * Detect the active theme from the actually applied CSS variable.
 * More reliable than parsing `data-themes` because it reflects the theme
 * that is really rendered, whatever the instance theming.
 *
 * @return {boolean}
 */
function isDarkTheme() {
	const bg = getComputedStyle(document.body).getPropertyValue('--color-main-background').trim()
	const rgb = parseCssColor(bg)
	if (rgb) {
		const luminance = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]
		return luminance < 128
	}
	const themes = (document.body.dataset.themes || document.body.dataset.theme || '').split(',').map((s) => s.trim())
	return themes.some((theme) => theme.includes('dark'))
}

/**
 * Read a CSS custom property from the currently applied NC theme.
 *
 * @param {string} name the CSS variable name
 * @param {string} fallback the fallback value when the variable is empty
 * @return {string}
 */
function readCssVar(name, fallback) {
	const value = getComputedStyle(document.body).getPropertyValue(name).trim()
	return value || fallback
}

/**
 * Key identifying the current theme for the mermaid palette.
 * Changes whenever the applied NC theme changes.
 *
 * @return {string}
 */
function mermaidThemeKey() {
	return String(isDarkTheme()) + ':' + readCssVar('--color-main-background', '')
}

/**
 * Build the mermaid config for the currently applied theme. Every palette
 * colour is taken from the NC CSS variables, so diagrams follow the
 * installed theme (light / dark / high-contrast) automatically.
 */
function mermaidConfig() {
	const variables = { darkMode: isDarkTheme() }
	for (const [key, cssVar] of Object.entries(MERMAID_THEME_VARS)) {
		const value = readCssVar(cssVar, '')
		if (value) {
			variables[key] = value
		}
	}
	return {
		startOnLoad: false,
		securityLevel: 'strict',
		suppressErrorRendering: true,
		theme: 'base',
		themeVariables: variables,
		fontFamily: 'inherit',
	}
}

/**
 * Escape a string so it can be embedded as HTML text content safely.
 *
 * @param {string} s the raw string
 * @return {string}
 */
function escapeHtml(s) {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
}

/**
 * Lazily load the shared mermaid bundle (loaded once per page).
 *
 * @return {Promise<import('mermaid').default>}
 */
function loadMermaid() {
	if (mermaidPromise === null) {
		mermaidPromise = import(/* webpackChunkName: "mermaid" */ 'mermaid').then((module) => module.default)
	}
	return mermaidPromise
}

/**
 * Render a single mermaid slot. Idempotent: a rendered slot is never drawn
 * twice. On parse errors the diagram source is shown instead of a broken SVG.
 *
 * @param {HTMLElement} slot the mermaid slot
 * @return {Promise<void>}
 */
async function renderMermaidSlot(slot) {
	const encoded = slot.dataset.src
	if (!encoded || slot.dataset.rendered === '1') {
		return
	}

	slot.classList.add('readmemd-mermaid-slot--loading')
	const stage = slot.querySelector('.readmemd-mermaid-slot__stage')
	if (stage === null) {
		return
	}

	let source = ''
	try {
		source = decodeURIComponent(encoded)
	} catch (error) {
		source = encoded
	}

	try {
		const mermaid = await loadMermaid()
		const themeKey = mermaidThemeKey()
		if (themeKey !== mermaidConfigThemeKey) {
			mermaid.initialize(mermaidConfig())
			mermaidConfigThemeKey = themeKey
		}
		const id = 'mermaid-' + (++mermaidDiagramId)
		const { svg } = await mermaid.render(id, source)
		stage.innerHTML = svg
		slot.dataset.rendered = '1'
		slot.classList.remove('readmemd-mermaid-slot--loading')
		slot.classList.add('readmemd-mermaid-slot--ready')
	} catch (error) {
		logger.debug('Mermaid render failed', error)
		stage.innerHTML = '<pre class="readmemd-mermaid-slot__error">' + escapeHtml(source) + '</pre>'
		slot.dataset.rendered = '1'
		slot.classList.remove('readmemd-mermaid-slot--loading')
		slot.classList.add('readmemd-mermaid-slot--error')
	}
}

/**
 * Render every mermaid slot of a markdown container in one batch. Rendering
 * all diagrams of a document at once (instead of per-viewport) keeps the
 * layout stable: the container grows only once, well before it is visible,
 * so scrolling through the README never shifts.
 *
 * A small macrotask yield between diagrams keeps the main thread responsive.
 *
 * @param {HTMLElement} container the markdown container
 * @return {Promise<void>}
 */
async function renderMermaidContainer(container) {
	const slots = Array.from(container.querySelectorAll('.readmemd-mermaid-slot'))
	for (const slot of slots) {
		if (slot.dataset.rendered !== '1') {
			await renderMermaidSlot(slot)
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
	}
}

/**
 * Observe a markdown container and batch-render its mermaid slots as soon as
 * it approaches the viewport, so the diagrams are ready before being seen.
 *
 * @param {HTMLElement} container the markdown container
 */
function observeMermaidContainer(container) {
	if (typeof IntersectionObserver === 'undefined') {
		renderMermaidContainer(container)
		return
	}
	if (mermaidObserver === null) {
		mermaidObserver = new IntersectionObserver((entries) => {
			for (const entry of entries) {
				if (entry.isIntersecting) {
					mermaidObserver.unobserve(entry.target)
					observedMermaidContainers.delete(entry.target)
					renderMermaidContainer(entry.target)
				}
			}
		}, { rootMargin: '1000px 0px' })
	}
	// Observing an already observed target is a no-op, so this is safe to
	// call again on every content update.
	mermaidObserver.observe(container)
	observedMermaidContainers.add(container)
}

/**
 * Re-render the diagrams that are currently visible when the NC theme flips,
 * so the palette follows the new theme without a page reload.
 */
function rerenderMermaidSlots() {
	if (document.hidden) {
		return
	}
	document.querySelectorAll('.readmemd-mermaid-slot[data-rendered="1"]').forEach((slot) => {
		const rect = slot.getBoundingClientRect()
		if (rect.bottom < 0 || rect.top > window.innerHeight) {
			return
		}
		delete slot.dataset.rendered
		slot.classList.remove('readmemd-mermaid-slot--ready', 'readmemd-mermaid-slot--error')
		const stage = slot.querySelector('.readmemd-mermaid-slot__stage')
		if (stage !== null) {
			stage.innerHTML = '<span class="readmemd-mermaid-slot__spinner"></span>'
		}
		renderMermaidSlot(slot)
	})
}

/** Watch the body for theme changes and re-paint visible diagrams. */
function ensureMermaidThemeWatcher() {
	if (mermaidThemeWatcher !== null) {
		return
	}
	mermaidThemeWatcher = new MutationObserver(() => {
		const themeKey = mermaidThemeKey()
		if (themeKey === mermaidConfigThemeKey) {
			return
		}
		// Force re-initialisation on the next render of a diagram.
		mermaidConfigThemeKey = ''
		rerenderMermaidSlots()
	})
	mermaidThemeWatcher.observe(document.documentElement, {
		attributes: true,
		attributeFilter: ['class', 'data-theme', 'data-themes', 'style'],
	})
	mermaidThemeWatcher.observe(document.body, {
		attributes: true,
		attributeFilter: ['class', 'data-theme', 'data-themes', 'style'],
	})
}

export default {
	name: 'MarkdownEngine',
	props: {
		content: {
			type: String,
			default: '',
		},
		mode: {
			type: String,
			default: 'private',
		},
		path: {
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
			this.renderedContent = await this.renderMD()
		},

	},

	created() {

		const slugify = (s) => 'md-' + encodeURIComponent(String(s).trim().toLowerCase().replace(/\s+/g, '-'))

		this.converter = markdownit({ html: false, breaks: true, linkify: true, typographer: true })
			.enable('strikethrough')
	        .enable('table')
			.use(markdownitcontainer, 'info')
			.use(markdownitcontainer, 'warn')
			.use(markdownitcontainer, 'error')
			.use(markdownitcontainer, 'success')
			.use(markdownittasklist, { enabled: true })
	        .use(implicitFigures)
			.use(markdownitimsize)
			.use(markdownitemoji)
			.use(markdownitanchor, { slugify })
			.use(markdownittocdoneright)
			.use(markdownitreplacelink, {
				 replaceLink: (link, env) => {
					if (link.startsWith('mailto:') || link.startsWith('http://') || link.startsWith('https://') || link.startsWith(generateUrl('core/preview'))) {
						return link
					} else {
						if (this.mode === 'public') {
							const token = loadState('files_sharing', 'sharingToken')
							return generateUrl('/s/{token}/download?path={path}&files={file}', { token, path: this.path, file: link })
						} else {
							let dir
							dir = this.path
							if (link.startsWith('/')) {
								dir = ''
							}
							return OC.linkToRemoteBase('files' + dir + '/' + link)
						}
					}
				},
			})

		const defaultRender = this.converter.renderer.rules.link_open || function(tokens, idx, options, env, self) {
			return self.renderToken(tokens, idx, options)
		}

		// force open to new tabs
		this.converter.renderer.rules.link_open = function(tokens, idx, options, env, self) {
			// If you are sure other plugins can't add `target` - drop check below
			const aIndex = tokens[idx].attrIndex('target')

			if (aIndex < 0) {
				tokens[idx].attrPush(['target', '_blank']) // add new attribute
			} else {
				tokens[idx].attrs[aIndex][1] = '_blank' // replace value of existing attr
			}

			// pass token to default renderer.
			return defaultRender(tokens, idx, options, env, self)
		}

		logger.debug('Markdown engine loaded')

	},

	updated() {
		this.forceCheckBox()
		this.enhanceCodeBlocks()
		this.renderMermaidSlots()
	},

	methods: {

		async renderMD() {

			await this.loadAdditionnalMDPlugins(this.converter)
			return this.converter.render(this.content)
		},

		async loadAdditionnalMDPlugins(converter) {

			const promiseList = []

			/** highlightjs */
			if (this.content.indexOf('```') !== -1) {
				const isDark = isDarkTheme()
				promiseList.push(import(/* webpackChunkName: "m-it-highlightjs" */ 'markdown-it-highlightjs').then(module => {
					if (isDark) {
						import(/* webpackChunkName: "m-it-highlightjs-css-dark" */ 'highlight.js/styles/github-dark.css')
					} else {
						import(/* webpackChunkName: "m-it-highlightjs-css" */ 'highlight.js/styles/github.css')
					}
					converter.use(module.default)
					// Keep ` ```mermaid ` fences out of highlight.js (unknown language
					// would throw and log); the content stays escaped in the DOM so
					// buildMermaidSlot can read it back later.
					const defaultHighlight = converter.options.highlight
					converter.options.highlight = (code, lang) => {
						if (lang === 'mermaid') {
							return converter.utils.escapeHtml(code)
						}
						return defaultHighlight(code, lang)
					}
					logger.debug('highlightjs loaded')
				}))
			}

			/** Mermaid is handled lazily after render (see renderMermaidSlots). */

			/** Latex */
			if (this.content.indexOf('$') !== -1) {
				promiseList.push(import(/* webpackChunkName: "katex" */ 'katex'))
				promiseList.push(import(/* webpackChunkName: "m-it-katex" */ '@vscode/markdown-it-katex').then(module => {
					converter.use(module.default)
					logger.debug('Katex loaded')
				}))
			}

			return Promise.all(promiseList)

		},

		forceCheckBox() {
			const checkboxs = this.$refs.container.querySelectorAll('input[type=checkbox]');
			[].forEach.call(checkboxs, (cb) => {
				cb.onclick = function() { return false }
			})
		},

		/**
		 * Wrap every code block into a github-style toolbar (language + copy),
		 * and turn ` ```mermaid ` fences into lazily rendered diagram slots.
		 */
		enhanceCodeBlocks() {
			const container = this.$refs.container
			if (container === null) {
				return
			}

			container.querySelectorAll('pre').forEach((pre) => {
				if (pre.parentElement !== null && pre.parentElement.classList.contains('readmemd-code')) {
					return
				}

				if (this.getCodeLanguage(pre) === 'mermaid') {
					this.buildMermaidSlot(pre)
					return
				}

				const wrapper = document.createElement('div')
				wrapper.className = 'readmemd-code'

				const header = document.createElement('div')
				header.className = 'readmemd-code__header'

				const lang = this.getCodeLanguage(pre)
				if (lang !== '') {
					const langLabel = document.createElement('span')
					langLabel.className = 'readmemd-code__lang'
					langLabel.textContent = lang
					header.appendChild(langLabel)
				}

				const copy = document.createElement('button')
				copy.type = 'button'
				copy.className = 'readmemd-code__copy'
				copy.title = 'Copy'
				copy.setAttribute('aria-label', 'Copy')
				copy.innerHTML = ICON_COPY
				copy.addEventListener('click', () => this.copyText(pre.innerText, copy))
				header.appendChild(copy)

				pre.parentNode.insertBefore(wrapper, pre)
				wrapper.appendChild(header)
				wrapper.appendChild(pre)
			})
		},

		/**
		 * Replace a mermaid-marked fence with a lazily rendered diagram slot.
		 * The diagram source is kept URL-encoded in a data attribute so it is
		 * protected from any later DOM processing and survives re-renders.
		 *
		 * @param {HTMLElement} pre the mermaid code block
		 */
		buildMermaidSlot(pre) {
			const code = pre.querySelector('code')
			const source = code !== null ? code.textContent : pre.textContent

			const wrapper = document.createElement('div')
			wrapper.className = 'readmemd-mermaid-slot'
			wrapper.dataset.src = encodeURIComponent(source)

			const header = document.createElement('div')
			header.className = 'readmemd-code__header'

			const langLabel = document.createElement('span')
			langLabel.className = 'readmemd-code__lang'
			langLabel.textContent = 'mermaid'
			header.appendChild(langLabel)

			const copy = document.createElement('button')
			copy.type = 'button'
			copy.className = 'readmemd-code__copy'
			copy.title = 'Copy'
			copy.setAttribute('aria-label', 'Copy')
			copy.innerHTML = ICON_COPY
			copy.addEventListener('click', () => this.copyText(source, copy))
			header.appendChild(copy)

			const stage = document.createElement('div')
			stage.className = 'readmemd-mermaid-slot__stage'
			stage.innerHTML = '<span class="readmemd-mermaid-slot__spinner"></span>'

			wrapper.appendChild(header)
			wrapper.appendChild(stage)
			pre.parentNode.replaceChild(wrapper, pre)
		},

		/**
		 * Batch-render the mermaid slots of the current document as soon as it
		 * approaches the viewport. Safe to call on every update.
		 */
		renderMermaidSlots() {
			const container = this.$refs.container
			if (container === null) {
				return
			}
			// Drop stale targets from destroyed markdown engines without
			// touching the observations of sibling instances: the header and
			// the footer each run their own engine on the shared observer.
			for (const observed of observedMermaidContainers) {
				if (!observed.isConnected) {
					if (mermaidObserver !== null) {
						mermaidObserver.unobserve(observed)
					}
					observedMermaidContainers.delete(observed)
				}
			}
			ensureMermaidThemeWatcher()
			if (container.querySelector('.readmemd-mermaid-slot') !== null) {
				observeMermaidContainer(container)
			}
		},

		/**
		 * Extract the language label from a code block (`language-bash`, ...).
		 *
		 * @param {HTMLElement} pre the code block
		 * @return {string}
		 */
		getCodeLanguage(pre) {
			const code = pre.querySelector('code')
			if (code === null) {
				return ''
			}
			const m = code.className.match(/language-([\w-]+)/)
			return m ? m[1] : ''
		},

		/**
		 * Copy arbitrary text to the clipboard with a visual confirmation
		 * on the button (check mark on success, error style on failure).
		 *
		 * @param {string} text the text to copy
		 * @param {HTMLElement} button the copy button
		 */
		async copyText(text, button) {
			let copied = false
			try {
				await navigator.clipboard.writeText(text)
				copied = true
			} catch (error) {
				try {
					const textarea = document.createElement('textarea')
					textarea.value = text
					textarea.style.position = 'fixed'
					textarea.style.opacity = '0'
					document.body.appendChild(textarea)
					textarea.select()
					copied = document.execCommand('copy')
					document.body.removeChild(textarea)
				} catch (innerError) {
					copied = false
				}
			}

			if (copied) {
				button.classList.add('readmemd-code__copy--copied')
				button.innerHTML = ICON_CHECK
				setTimeout(() => {
					button.classList.remove('readmemd-code__copy--copied')
					button.innerHTML = ICON_COPY
				}, 2000)
			} else {
				button.classList.add('readmemd-code__copy--error')
				setTimeout(() => {
					button.classList.remove('readmemd-code__copy--error')
				}, 2000)
			}
		},
	},

}
</script>

<style>
.headermd thead,
.footermd thead
{
	position: initial !important;
}
</style>
