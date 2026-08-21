/**
 * @author Matthieu Le Corre <matthieu.lecorre@univ-nantes.fr>
 *
 * @license AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 */
import Vue from 'vue'
import { registerFileListHeader } from '@nextcloud/files'
import Readmemd from './view/Readmemd.vue'
import logger from './logger.js'
import { installVirtualListClamp, rollbackVirtualListClamp, syncPageScroll, isPageScrollActive } from './virtuallist.js'
import './markdown.css'

const ReadmemdView = Vue.extend(Readmemd)

const SUPPORTED_VIEWS = new Set(['files', 'favorites', 'public-share', 'public-file-share'])

/**
 * Whether the header/footer should be rendered for the given view.
 *
 * @param {import('@nextcloud/files').IView} view the active view
 * @return {boolean}
 */
function isSupportedView(view) {
	if (SUPPORTED_VIEWS.has(view.id)) {
		return true
	}
	// In Nextcloud >= 33 favorite folders are separate views
	// with a generated id and a `favorites` parent.
	return view.parent === 'favorites'
}

let headerMount = null
let footerMount = null
let headerEl = null
let lastPath = null

/**
 * Mount the header component into the element provided by the file list.
 * The mount point is appended inside `el` instead of replacing it because
 * `el` is managed by the Nextcloud file list (Vue 3) and must stay intact.
 *
 * The card is rendered into a `.readmemd-header-anchor` wrapper that is placed
 * directly above the breadcrumbs (`.files-list__header`) so the project header
 * sits on top of the page, GitHub-style. When the breadcrumbs are not present
 * yet, the wrapper falls back to the mount point provided by the file list.
 *
 * @param {HTMLElement} el mount point provided by the file list
 * @param {import('@nextcloud/files').IView} view the active file list view
 * @param {string} path current folder path
 */
function mountHeader(el, view, path) {
	// Remove a relocated header wrapper left behind by a previous view.
	document.querySelectorAll('.readmemd-header-anchor').forEach((node) => node.remove())
	const container = document.createElement('div')
	container.className = 'readmemd-header-anchor'
	const inner = document.createElement('div')
	container.appendChild(inner)
	const breadcrumbs = document.querySelector('.files-list__header')
	if (breadcrumbs !== null && breadcrumbs.parentElement !== null) {
		breadcrumbs.parentElement.insertBefore(container, breadcrumbs)
	} else {
		el.appendChild(container)
	}
	headerMount = new ReadmemdView({
		data: {
			name: 'readmemd-header',
			zone: 'headermd',
			fileTableView: view,
			path,
		},
	}).$mount(inner)
}

/**
 * Mount the footer component below the file list, inside the scroll container
 * so it is reachable by scrolling like gitlab's README section.
 *
 * @param {import('@nextcloud/files').IView} view the active file list view
 * @param {string} path current folder path
 */
function mountFooter(view, path) {
	const table = document.querySelector('.files-list__table')
	if (table === null) {
		return
	}
	// Remove any previously inserted footer that is no longer managed by a
	// mounted component (e.g. after switching between views).
	const previous = document.querySelector('.readmemd-footer-anchor')
	if (previous !== null) {
		previous.remove()
	}
	const container = document.createElement('div')
	container.className = 'readmemd-footer-anchor'
	table.after(container)
	const inner = document.createElement('div')
	container.appendChild(inner)
	footerMount = new ReadmemdView({
		data: {
			name: 'readmemd-footer',
			zone: 'footermd',
			fileTableView: view,
			path,
		},
	}).$mount(inner)
	// The footer is real content below the virtualized rows. Clamp the virtual
	// list index so the spacer padding cannot grow past the last row, keeping a
	// single smooth GitHub-like scroll instead of the accelerating "treadmill".
	installVirtualListClamp()
}

/**
 * Render the header and footer for the current folder.
 *
 * Called by the file list when the header component is mounted.
 *
 * @param {HTMLElement} el mount point provided by the file list
 * @param {import('@nextcloud/files').IFolder} folder the current folder
 * @param {import('@nextcloud/files').IView} view the active view
 */
function render(el, folder, view) {
	// The header component is freshly mounted, reset the previous state.
	headerEl = el
	headerMount = null
	footerMount = null
	lastPath = folder.path
	// Keep the whole-page scroll rebind in sync with the current CSS state.
	syncPageScroll()
	if (isPageScrollActive()) {
		const appContent = document.querySelector('#app-content-vue')
		if (appContent !== null) {
			appContent.scrollTop = 0
		}
	}
	if (!isSupportedView(view)) {
		rollbackVirtualListClamp()
		return
	}
	mountHeader(el, view, folder.path)
	mountFooter(view, folder.path)
}

/**
 * Update the header and footer when the current folder changes.
 *
 * Called by the file list on every folder change, even for views
 * that were not rendered yet.
 *
 * @param {import('@nextcloud/files').IFolder} folder the current folder
 * @param {import('@nextcloud/files').IView} view the active view
 */
function updated(folder, view) {
	syncPageScroll()
	if (folder.path !== lastPath) {
		lastPath = folder.path
		// The list is not scrollable anymore in page-scroll mode, so the
		// virtual list can no longer reset its own scroll position: scroll
		// the page scroller to the top instead.
		if (isPageScrollActive()) {
			const appContent = document.querySelector('#app-content-vue')
			if (appContent !== null) {
				appContent.scrollTop = 0
			}
		}
	}
	if (!isSupportedView(view)) {
		return
	}
	// Update already mounted components first: a failing footer mount must
	// not leave the header pointing at the previous folder.
	if (headerMount !== null) {
		headerMount.$data.path = folder.path
	}
	if (footerMount !== null) {
		footerMount.$data.path = folder.path
	}
	// `updated` can be fired on a view that was not rendered yet
	// (e.g. the file list was opened on another view first).
	if (headerMount === null && headerEl !== null) {
		mountHeader(headerEl, view, folder.path)
	}
	if (footerMount === null) {
		mountFooter(view, folder.path)
	}
	// Re-apply on the current list instance (a new view may have mounted since).
	installVirtualListClamp()
}

/**
 * Register the README.md header and footer in the file list.
 */
export function registerReadmemdHeader() {
	registerFileListHeader({
		id: 'readmemd',
		order: 100,
		enabled: (folder, view) => isSupportedView(view),
		render,
		updated,
	})
	logger.debug('ReadmeMD header registered')
}
