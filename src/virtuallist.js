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
/**
 * VirtualList index clamp for the Nextcloud file list.
 *
 * The README footer is rendered as real content below the table, inside the
 * virtualized scroll container (`.files-list`). The virtual list computes its
 * spacer padding from the scroll position without an upper bound, so once the
 * user scrolls past the last virtual row (into the footer) the spacer keeps
 * growing 1:1 with the scroll position. The scrollable height then grows as
 * fast as the user scrolls, which accelerates and eventually freezes the
 * scroll ("treadmill" effect).
 *
 * The only way to keep a single, GitHub-like scroll (file list + README in one
 * flow) is to clamp the computed row index at the total row count so the
 * spacer stops growing past the last real row. The remaining scroll distance is
 * then covered by the real README content like a regular long document.
 *
 * This module patches the VirtualList component instance found on the
 * `.files-list` element. The patch is safe: it is feature-detected, applied at
 * most once per instance and silently skipped if the Nextcloud internals
 * change in a future version (the worst case is the original behaviour).
 */

/**
 * WeakSet of already patched VirtualList instances.
 */
const patchedInstances = new WeakSet()

/**
 * WeakMap storing the original scrollPosToIndex for each patched instance.
 */
const originalMethods = new WeakMap()

/**
 * Find the VirtualList component instance hosting the given element.
 *
 * Nextcloud's files app still exposes its components through the Vue 2 style
 * `__vue__` property on the component root element; fall back to the Vue 3
 * `__vueParentComponent` property just in case.
 *
 * @param {HTMLElement|null} el element rendered by the VirtualList
 * @return {object|null} the component instance or null when not found
 */
function findVirtualList(el) {
	if (el === null) {
		return null
	}
	const instance = el.__vue__ || el.__vueParentComponent
	if (instance === null || instance === undefined) {
		return null
	}
	if (typeof instance.scrollPosToIndex !== 'function') {
		return null
	}
	if (!('totalRowCount' in instance) || !('columnCount' in instance)) {
		return null
	}
	return instance
}

/**
 * Clamp the virtual list index at the total row count so the spacer padding
 * cannot grow past the last real row. Safe to call on every file list render.
 */
export function installVirtualListClamp() {
	const instance = findVirtualList(document.querySelector('.files-list'))
	if (instance === null || patchedInstances.has(instance)) {
		return
	}
	const original = instance.scrollPosToIndex
	patchedInstances.add(instance)
	originalMethods.set(instance, original)
	instance.scrollPosToIndex = (position) => {
		const maxIndex = Math.max(0, instance.totalRowCount * instance.columnCount)
		return Math.min(original(position), maxIndex)
	}
}

/**
 * Restore the original scrollPosToIndex on a previously patched instance.
 *
 * @param {HTMLElement|null} el element rendered by the VirtualList
 */
export function rollbackVirtualListClamp(el) {
	const instance = findVirtualList(el ?? document.querySelector('.files-list'))
	if (instance === null) {
		return
	}
	const original = originalMethods.get(instance)
	if (original === undefined) {
		return
	}
	instance.scrollPosToIndex = original
	patchedInstances.delete(instance)
	originalMethods.delete(instance)
}

/**
 * Whole-page scroll mode for the Nextcloud file list.
 *
 * A theme can make the file list grow with its content (`overflow: visible`)
 * so the whole files area scrolls as one document, GitHub-style. Nextcloud's
 * VirtualList however derives its row index from `$el.scrollTop`, which stops
 * updating once the list is no longer the scroll container.
 *
 * This module detects that situation at runtime (computed overflow of the
 * `.files-list` element) and, when active, rebinds the virtual list to the
 * page scroller (`#app-content-vue`):
 *
 *  - `onScroll` derives the row index from the page scroller and keeps
 *    `$el.scrollTop` in sync so `scrollTo`'s "already visible" short-circuit
 *    stays consistent with the page position;
 *  - `visibleRows` is derived from the real viewport height, otherwise the
 *    list's ResizeObserver would see the ever-growing element and render
 *    every row at once;
 *  - `scrollTo` mirrors the computed scroll position onto the page scroller
 *    (keyboard navigation / position restore).
 *
 * Everything is feature-detected; if the Nextcloud internals change, the worst
 * case is the original list-scrolled behaviour. Themes can key cosmetic rules
 * off the `readmemd-page-scroll` marker class added to `#app-content-vue`.
 */

const pageScrollState = {
	active: false,
	instance: null,
	appContent: null,
	list: null,
	scrollListener: null,
	originalOnScroll: null,
	originalScrollTo: null,
	originalVisibleRows: null,
}

/**
 * Resolve the elements needed for the whole-page scroll mode.
 *
 * @return {object|null} `{ list, appContent }` or null when the list is not
 *     laid out as a page scroller (e.g. the theme is not installed).
 */
function getScrollTargets() {
	const list = document.querySelector('.files-list')
	const appContent = document.querySelector('#app-content-vue')
	if (list === null || appContent === null) {
		return null
	}
	// The theme opts into page-scroll by making the list overflow: visible.
	if (getComputedStyle(list).overflowY !== 'visible') {
		return null
	}
	return { list, appContent }
}

/**
 * Distance from the top of the page scroller's content to the top of the list.
 *
 * @param {HTMLElement} list the `.files-list` element
 * @param {HTMLElement} appContent the page scroller
 * @return {number} offset in pixels
 */
function getListContentOffset(list, appContent) {
	return list.getBoundingClientRect().top
		- appContent.getBoundingClientRect().top
		+ appContent.scrollTop
}

/**
 * Toggle the `readmemd-breadcrumbs-stuck` class on the page scroller when the
 * sticky breadcrumbs detach from the card (pinned GitHub-style sub-header).
 *
 * @param {HTMLElement} appContent the page scroller
 */
function updateBreadcrumbsStuck(appContent) {
	const breadcrumbs = document.querySelector('.files-list__header')
	if (breadcrumbs === null) {
		return
	}
	const top = appContent.getBoundingClientRect().top
	const stuck = appContent.scrollTop > 0 && breadcrumbs.getBoundingClientRect().top <= top + 1
	appContent.classList.toggle('readmemd-breadcrumbs-stuck', stuck)
}

/**
 * Activate the whole-page scroll rebind. Safe to call on every render; only
 * the first successful activation mutates the VirtualList instance.
 *
 * @return {boolean} whether the rebind is active
 */
function installPageScroll() {
	if (pageScrollState.active) {
		return true
	}
	const targets = getScrollTargets()
	if (targets === null) {
		return false
	}
	const { list, appContent } = targets
	const instance = findVirtualList(list)
	if (instance === null) {
		return false
	}

	const originalOnScroll = instance.onScroll
	const originalScrollTo = instance.scrollTo

	// visibleRows must follow the real viewport: derived from the (now
	// growing) list element it would make the ResizeObserver render every row.
	let originalVisibleRows = null
	try {
		const hasOwn = Object.prototype.hasOwnProperty.call(instance, 'visibleRows')
		const descriptor = Object.getOwnPropertyDescriptor(instance, 'visibleRows')
		if (hasOwn && descriptor !== undefined && descriptor.configurable === false) {
			return false
		}
		originalVisibleRows = hasOwn ? descriptor : null
		Object.defineProperty(instance, 'visibleRows', {
			configurable: true,
			get() {
				const viewportHeight = appContent.clientHeight
				const headerHeight = typeof instance.headerHeight === 'number' ? instance.headerHeight : 0
				return Math.max(0, Math.floor((viewportHeight - headerHeight) / instance.itemHeight))
			},
		})
	} catch (error) {
		return false
	}

	// Derive the row index from the page scroller. `$el.scrollTop` is kept in
	// sync so scrollTo()'s "already visible" check still matches the page.
	instance.onScroll = () => {
		const position = Math.max(0, appContent.scrollTop - getListContentOffset(list, appContent))
		if (instance.$el !== null && instance.$el !== undefined) {
			instance.$el.scrollTop = position
		}
		const index = instance.scrollPosToIndex(position)
		if (index !== instance.index) {
			instance.index = Math.max(0, Math.floor(index))
			instance.$emit('scroll')
		}
	}

	// scrollTo() writes $el.scrollTop, a no-op on a non-scrollable list.
	// Mirror the computed value onto the page scroller.
	if (typeof originalScrollTo === 'function') {
		instance.scrollTo = function(index) {
			originalScrollTo.call(this, index)
			const offset = getListContentOffset(list, appContent)
			appContent.scrollTop = offset + (this.$el !== null && this.$el !== undefined ? this.$el.scrollTop : 0)
		}
	}

	const scrollListener = () => {
		requestAnimationFrame(() => {
			instance.onScroll()
			updateBreadcrumbsStuck(appContent)
		})
	}
	appContent.addEventListener('scroll', scrollListener, { passive: true })
	instance.onScroll()
	updateBreadcrumbsStuck(appContent)

	pageScrollState.active = true
	pageScrollState.instance = instance
	pageScrollState.appContent = appContent
	pageScrollState.list = list
	pageScrollState.scrollListener = scrollListener
	pageScrollState.originalOnScroll = originalOnScroll
	pageScrollState.originalScrollTo = originalScrollTo
	pageScrollState.originalVisibleRows = originalVisibleRows
	appContent.classList.add('readmemd-page-scroll')
	return true
}

/**
 * Deactivate the whole-page scroll rebind and restore the VirtualList.
 */
export function rollbackPageScroll() {
	if (!pageScrollState.active) {
		return
	}
	const {
		instance,
		appContent,
		scrollListener,
		originalOnScroll,
		originalScrollTo,
		originalVisibleRows,
	} = pageScrollState
	if (appContent !== null && scrollListener !== null) {
		appContent.removeEventListener('scroll', scrollListener)
	}
	if (instance !== null) {
		if (originalOnScroll !== undefined) {
			instance.onScroll = originalOnScroll
		}
		if (originalScrollTo !== undefined) {
			instance.scrollTo = originalScrollTo
		}
		if (originalVisibleRows !== null) {
			try {
				Object.defineProperty(instance, 'visibleRows', originalVisibleRows)
			} catch (error) {
				// Keep the patched getter; restoring is best-effort.
			}
		} else {
			try {
				delete instance.visibleRows
			} catch (error) {
				// ignore
			}
		}
	}
	if (appContent !== null) {
		appContent.classList.remove('readmemd-page-scroll', 'readmemd-breadcrumbs-stuck')
	}
	pageScrollState.active = false
	pageScrollState.instance = null
	pageScrollState.appContent = null
	pageScrollState.list = null
	pageScrollState.scrollListener = null
	pageScrollState.originalOnScroll = null
	pageScrollState.originalScrollTo = null
	pageScrollState.originalVisibleRows = null
}

/**
 * Keep the whole-page scroll mode in sync with the current DOM/CSS state.
 * Safe to call on every render and folder change.
 */
export function syncPageScroll() {
	if (pageScrollState.active) {
		if (getScrollTargets() === null) {
			rollbackPageScroll()
		}
		return
	}
	installPageScroll()
}

/**
 * Whether the whole-page scroll rebind is currently active.
 *
 * @return {boolean}
 */
export function isPageScrollActive() {
	return pageScrollState.active
}
