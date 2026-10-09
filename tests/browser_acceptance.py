#!/usr/bin/env python3
"""Mobile interaction checks with isolated official-example API responses.

Run against the local dev server. All /api requests are intercepted, including
POSTs, so this script cannot create a supplier order or call payment endpoints.
"""

import argparse
from contextlib import contextmanager
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import re
import sys
import traceback
from urllib.parse import parse_qs, quote, urlparse

from playwright.sync_api import expect, sync_playwright

from fixture_router import EXAMPLES, FixtureRouter


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts" / "browser"
TITLE = EXAMPLES["products"]["data"]["products"][0]["title"]


@contextmanager
def mobile_page(browser, origin, *, categories=None, cities=None, **variants):
    context = browser.new_context(viewport={"width": 390, "height": 844},
                                  device_scale_factor=1, is_mobile=True,
                                  has_touch=True, locale="zh-CN",
                                  timezone_id="Europe/London")
    router = FixtureRouter(origin, **variants)
    router.install(context)
    if categories is not None:
        context.route("**/api/catalog/categories", lambda route: router.fulfill(route, {"success": True, "data": categories}))
    if cities is not None:
        context.route("**/api/catalog/cities", lambda route: router.fulfill(route, {"success": True, "data": cities}))
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    try:
        page.goto(origin, wait_until="networkidle")
        yield page, router
        assert not router.unexpected, router.unexpected
        assert not errors, errors
        assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1"), "Page overflows the mobile viewport"
    finally:
        context.close()


def screenshot(page, name):
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(ARTIFACTS / f"{name}.png"), full_page=True)
    page.screenshot(path=str(ARTIFACTS / f"{name}.viewport.png"), full_page=False)


def search_box(page):
    return page.get_by_role("textbox", name="搜索目的地/活动", exact=True)


def open_search_deep_link(page):
    """Verify the shareable search route after the results editor was removed."""
    current = urlparse(page.url).fragment
    params = current.split("?", 1)[1] if "?" in current else ""
    path = f"/search?{params}&returnTo={quote(current, safe='')}"
    page.evaluate("path => { window.location.hash = path; }", path)
    expect(search_box(page)).to_be_visible()


def result_params(router):
    calls = [call for call in router.calls("/api/catalog/products")
             if call["params"].get("limit") == ["12"]]
    assert calls, "No catalogue results request was recorded"
    return calls[-1]["params"]


def expect_results_layout(page):
    expect(page.get_by_role("heading", name="活动列表", exact=True)).to_be_visible()
    expect(page.get_by_role("heading", level=2)).to_have_count(0)
    expect(page.locator(".cat-list-search")).to_have_count(0)
    expect(page.get_by_role("button", name="修改搜索", exact=True)).to_have_count(0)


def choose_destination(page):
    page.get_by_role("button", name="搜索目的地/活动", exact=True).click()
    expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
    search_box(page).fill("东京")
    city = page.locator('.ant-search-city[data-city-code="215"]')
    expect(city).to_contain_text("东京")
    expect(city).to_contain_text("日本")
    city.click()


def search_destination(page, router):
    choose_destination(page)
    expect(page).to_have_url(re.compile(r"/#/activities\?city=215(?:&|$)"))
    expect_results_layout(page)
    expect(page.get_by_role("heading", name="东京活动", exact=True)).to_have_count(0)
    expect(page.locator(".cat-hero")).to_have_count(0)
    expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
    assert result_params(router)["city_codes"] == ["215"]


def open_detail(page, router):
    search_destination(page, router)
    page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
    expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
    expect(page.locator(".detail-top-price strong")).to_contain_text("$")
    assert router.calendar_days, "The detail screen did not request an API calendar"


def open_booking_options(page):
    page.locator(".detail-mobile-booking").get_by_role("button", name="立即预订", exact=True).click()
    sheet = page.get_by_role("dialog", name="预订选项", exact=True)
    expect(sheet).to_be_visible()
    expect(sheet.locator(".detail-booking-sheet-footer strong")).to_be_visible()
    return sheet


def open_date_picker(page):
    page.locator(".detail-sheet-selector-date").click()
    picker = page.locator(".detail-picker-sheet.date")
    expect(picker).to_be_visible()
    return picker


def open_quantity_picker(page):
    page.locator(".detail-sheet-selector-quantity").click()
    picker = page.locator(".detail-picker-sheet.quantity")
    expect(picker).to_be_visible()
    expect(picker.locator(".detail-sku-info strong").first).to_contain_text("$")
    return picker


def choose_fixture_date(page, router):
    picker = open_date_picker(page)
    sold_out = picker.locator(".detail-calendar").get_by_role("button", name=re.compile(f"^{router.calendar_days[1]}，"))
    expect(sold_out).to_be_disabled()
    bookable = picker.locator(".detail-calendar").get_by_role("button", name=re.compile(f"^{router.calendar_days[2]}，"))
    expect(bookable).to_be_enabled()
    bookable.click()
    picker.locator(".detail-picker-confirm").click()
    sheet = page.get_by_role("dialog", name="预订选项", exact=True)
    expect(sheet.locator(".detail-sheet-selector-date strong")).to_contain_text(
        f'{int(router.calendar_days[2][5:7])}月{int(router.calendar_days[2][8:])}日'
    )
    return sheet


def test_search_page_and_simple_destination_search(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        expect(page.get_by_role("tab", name="活动", exact=True)).to_have_attribute("aria-selected", "true")
        expect(page.get_by_role("tab", name="酒店", exact=True).locator("svg")).to_have_count(0)
        expect(page.get_by_role("tab", name="机票", exact=True).locator("svg")).to_have_count(0)
        activity_tab = page.get_by_role("tab", name="活动", exact=True)
        expect(activity_tab.locator(".cat-service-active-surface")).to_have_attribute("aria-hidden", "true")
        expect(activity_tab.locator("span")).to_have_text("活动")
        expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_be_visible()
        expect(page.get_by_text("必填", exact=True)).to_have_count(0)
        expect(page.locator(".cat-destinations, .cat-result-count, .cat-bottom-nav")).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile(r"^出行日期"))).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile(r"^人数"))).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
        expect(page.get_by_text("选择目的地即可出发，日期和人数稍后再定。", exact=True)).to_have_count(0)
        screenshot(page, "01-home-official-fixture")
        page.locator(".cat-search-panel").get_by_role("button", name="查询", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        expect(page.locator(".cat-hero, .cat-product-card")).to_have_count(0)
        search_url = page.url
        page.reload(wait_until="networkidle")
        expect(page).to_have_url(search_url)
        search_box(page).fill("东京")
        with page.expect_response(lambda response: "/api/catalog/products?" in response.url
                                  and "city_codes=215" in response.url):
            page.locator('.ant-search-city[data-city-code="215"]').click()
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        expect(page).to_have_url(re.compile(r"/#/activities\?city=215(?:&|$)"))
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="东京活动", exact=True)).to_have_count(0)
        expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_have_count(0)
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        params = result_params(router)
        assert params["city_codes"] == ["215"]
        assert not {"start_date", "end_date", "adults"}.intersection(params)
        image = page.locator(".cat-product-card img").first
        expect(image).to_have_attribute("src", "https://cdn.example/banner.jpg")
        image.scroll_into_view_if_needed()
        page.wait_for_function("document.querySelector('.cat-product-card img')?.naturalWidth > 0")
        assert image.evaluate("node => node.naturalWidth > 0"), "API-sourced image did not render"
        screenshot(page, "02-catalog-official-fixture")


def test_chinese_labels_and_committed_destination(browser, origin):
    cities = [*EXAMPLES["cities"]["data"], {"city_code": "216", "city_name": "Kyoto", "country_name": "Japan"}]
    categories = [{"category_code": "20101", "category_name": "Theme Parks"},
                  {"category_code": "20102", "category_name": "Cruise"},
                  {"category_code": "20103", "category_name": "Water Parks"}]
    with mobile_page(browser, origin, categories=categories, cities=cities,
                     category_totals={"20101": 1, "20102": 4, "20103": 0}) as (page, router):
        expect(page.get_by_role("button", name="邮轮", exact=True)).to_be_visible()
        search_destination(page, router)
        category_row = page.locator(".cat-category-row")
        expect(category_row.get_by_role("button", name="主题乐园", exact=True)).to_be_visible()
        expect(category_row.get_by_role("button", name="邮轮", exact=True)).to_be_visible()
        expect(category_row.get_by_role("button", name="水上乐园", exact=True)).to_have_count(0)
        assert all(product["category_code"] != "20102" for product in EXAMPLES["products"]["data"]["products"]), "This fixture must keep Cruise absent from the first catalogue page"
        count_calls = {call["params"]["category_codes"][0]: call for call in router.calls("/api/catalog/products")
                       if call["params"].get("limit") == ["1"] and "category_codes" in call["params"]}
        assert {"20101", "20102", "20103"}.issubset(count_calls), "Every category needs its own authoritative count request"
        assert all(count_calls[code]["params"]["city_codes"] == ["215"] for code in ["20101", "20102", "20103"])
        expect(page.locator(".cat-product-location")).to_have_text("东京 · 日本")
        expect(page.locator(".cat-product-category")).to_have_text("主题乐园")
        open_search_deep_link(page)
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        search_box(page).fill("京都")
        city = page.locator('.ant-search-city[data-city-code="216"]')
        expect(city).to_contain_text("京都")
        expect(city).to_contain_text("日本")
        city.click()
        expect(page).to_have_url(re.compile(r"/#/activities\?city=216(?:&|$)"))
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="京都活动", exact=True)).to_have_count(0)
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        assert result_params(router)["city_codes"] == ["216"]
        with page.expect_response(lambda response: urlparse(response.url).path == "/api/catalog/products"
                                  and parse_qs(urlparse(response.url).query).get("limit") == ["12"]
                                  and parse_qs(urlparse(response.url).query).get("category_codes") == ["20101"]):
            page.get_by_role("button", name="主题乐园", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/activities\?.*&category=20101(?:&|$)"))
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="京都 · 主题乐园", exact=True)).to_have_count(0)
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        assert result_params(router)["category_codes"] == ["20101"]
        category_list = page.url
        page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
        page.get_by_role("button", name="返回活动列表", exact=True).click()
        expect(page).to_have_url(category_list)
        expect(page.get_by_role("button", name="主题乐园", exact=True)).to_have_class(re.compile(r"selected"))
        page.get_by_role("button", name="全部体验", exact=True).click()
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="京都活动", exact=True)).to_have_count(0)
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        assert "category" not in parse_qs(urlparse(page.url).fragment.split("?", 1)[1])


def test_list_reload_history_and_product_return(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        search_destination(page, router)
        initial_list = page.url
        open_search_deep_link(page)
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        modify_search = page.url
        search_box(page).fill("游船")
        assert page.url == modify_search
        search_box(page).press("Enter")
        expect(page).to_have_url(re.compile(r"/#/activities\?q="))
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        committed_list = page.url
        assert parse_qs(urlparse(committed_list).fragment.split("?", 1)[1])["q"] == ["游船"]
        page.reload(wait_until="networkidle")
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="“游船”的搜索结果", exact=True)).to_have_count(0)
        expect(page.get_by_role("button", name="修改搜索", exact=True)).to_have_count(0)
        assert result_params(router)["keyword"] == ["游船"]
        page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        page.get_by_role("button", name="返回活动列表", exact=True).click()
        expect(page).to_have_url(committed_list)
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="“游船”的搜索结果", exact=True)).to_have_count(0)
        page.go_back(wait_until="networkidle")
        expect(page).to_have_url(re.compile(r"/#/product/10549$"))
        page.go_back(wait_until="networkidle")
        expect(page).to_have_url(committed_list)
        page.go_back(wait_until="networkidle")
        expect(page).to_have_url(modify_search)
        page.go_back(wait_until="networkidle")
        expect(page).to_have_url(initial_list)
        page.go_back(wait_until="networkidle")
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        page.go_back(wait_until="networkidle")
        expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_be_visible()
        expect(page.locator(".cat-list-header")).to_have_count(0)
        page.go_forward(wait_until="networkidle")
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        page.go_forward(wait_until="networkidle")
        expect(page).to_have_url(initial_list)
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="东京活动", exact=True)).to_have_count(0)


def test_search_reload_and_close_returns_originating_list(browser, origin):
    with mobile_page(browser, origin, categories=[{"category_code": "20101", "category_name": "Theme Parks"}]) as (page, router):
        search_destination(page, router)
        page.get_by_role("button", name="主题乐园", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/activities\?.*&category=20101(?:&|$)"))
        original_list = page.url
        open_search_deep_link(page)
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        search_url = page.url
        page.reload(wait_until="networkidle")
        expect(page).to_have_url(search_url)
        search_box(page).fill("游船")
        expect(search_box(page)).to_have_value("游船")
        page.get_by_role("button", name="关闭地点选择", exact=True).click()
        expect(page).to_have_url(original_list)
        expect(page.get_by_role("button", name="主题乐园", exact=True)).to_have_class(re.compile(r"selected"))
        open_search_deep_link(page)
        search_box(page).fill("东京")
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        page.keyboard.press("Escape")
        expect(page).to_have_url(original_list)
        expect(page.get_by_role("button", name="主题乐园", exact=True)).to_have_class(re.compile(r"selected"))


def test_search_keyword_can_search_all_activities(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        page.get_by_role("button", name="搜索目的地/活动", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        search_box(page).fill("游船")
        search_box(page).press("Enter")
        expect(page).to_have_url(re.compile(r"/#/activities\?q="))
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="“游船”的搜索结果", exact=True)).to_have_count(0)
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        params = result_params(router)
        assert params["keyword"] == ["游船"]
        assert "city_codes" not in params


def test_search_category_suggestion_submits_immediately(browser, origin):
    categories = [{"category_code": "20101", "category_name": "Theme Parks"}]
    with mobile_page(browser, origin, categories=categories) as (page, router):
        page.get_by_role("button", name="搜索目的地/活动", exact=True).click()
        search_box(page).fill("东京")
        group = page.locator(".ant-search-city-group").filter(has=page.locator('.ant-search-city[data-city-code="215"]'))
        category = group.locator('.ant-search-category[data-category-code="20101"]')
        expect(category).to_contain_text("东京")
        expect(category).to_contain_text("主题乐园")
        expect(category).to_contain_text("1个活动")
        assert page.evaluate("localStorage.getItem('rollinggo.ant.search.recent.v1')") is None
        category.click()
        expect(page).to_have_url(re.compile(r"/#/activities\?city=215.*&category=20101(?:&|$)"))
        expect_results_layout(page)
        expect(page.get_by_role("heading", name="东京 · 主题乐园", exact=True)).to_have_count(0)
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        params = result_params(router)
        assert params["city_codes"] == ["215"]
        assert params["category_codes"] == ["20101"]
        assert page.evaluate("JSON.parse(localStorage.getItem('rollinggo.ant.search.recent.v1'))") == ["215"]


def test_empty_results_can_clear_committed_keyword(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        search_destination(page, router)
        def empty_keyword(route):
            params = parse_qs(urlparse(route.request.url).query)
            if params.get("keyword") != ["不存在的活动"]:
                route.fallback()
                return
            router.requests.append({"method": "GET", "path": "/api/catalog/products", "params": params, "body": None})
            router.fulfill(route, {"success": True, "data": {"products": [], "total": 0, "page": 1, "limit": 12, "has_next": False}})
        page.context.route("**/api/catalog/products?**", empty_keyword)
        open_search_deep_link(page)
        search_box(page).fill("不存在的活动")
        search_box(page).press("Enter")
        expect(page.get_by_role("heading", name="暂时没有找到相关活动", exact=True)).to_be_visible()
        page.get_by_role("button", name="查看全部体验", exact=True).click()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_be_visible()
        expect(page.locator(".cat-list-header")).to_have_count(0)
        assert urlparse(page.url).fragment in {"", "/"}


def test_direct_product_link_returns_home(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        page.goto(f"{origin}/#/product/10549", wait_until="networkidle")
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        page.get_by_role("button", name="返回活动列表", exact=True).click()
        expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_be_visible()


def test_catalog_starting_price_and_detail_without_favorites(browser, origin):
    with mobile_page(browser, origin, lowest_price_child=True) as (page, router):
        expect(page.locator(".cat-product-price, .cat-see-price, .cat-price-retry")).to_have_count(0)
        assert not router.calls("/api/catalog/prices"), "Homepage recommendations must not request prices"
        pending_prices = []
        def hold_price_response(route):
            pending_prices.append(route)
        page.context.route("**/api/catalog/prices?**", hold_price_response)
        search_destination(page, router)
        price_placeholder = page.locator(".cat-product-card .price-skeleton")
        expect(price_placeholder).to_be_visible()
        expect(price_placeholder).to_have_attribute("role", "status")
        expect(price_placeholder).to_have_attribute("aria-label", "正在加载价格")
        assert "查询价格" not in page.locator("body").inner_text()
        assert "报价加载中" not in page.locator("body").inner_text()
        assert pending_prices, "The results list did not request a price response"
        page.context.unroute("**/api/catalog/prices?**", hold_price_response)
        for route in pending_prices:
            router.handle(route)
        expect(page.locator(".cat-product-card .cat-product-price")).to_have_text(re.compile(r".*50\.00\s*起$"))
        expect(price_placeholder).to_have_count(0)
        expect(page.get_by_text("选择套餐查看价格", exact=True)).to_have_count(0)
        assert router.calls("/api/catalog/prices")[-1]["params"]["product_codes"] == ["10549"]
        pending_calendar = []
        def hold_calendar_response(route):
            pending_calendar.append(route)
        page.context.route("**/api/catalog/skus/calendar?**", hold_calendar_response)
        page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        expect(page.locator(".detail-top-price .price-skeleton")).to_be_visible()
        expect(page.locator(".detail-top-price .price-skeleton")).to_have_attribute("aria-label", "正在加载价格")
        expect(page.locator(".detail-mobile-booking .price-skeleton")).to_be_visible()
        expect(page.locator("#ant-packages .detail-date-loading")).to_be_visible()
        expect(page.locator("#ant-packages .detail-date-loading span")).to_have_count(3)
        assert "查询价格" not in page.locator("body").inner_text()
        assert "正在查询" not in page.locator("body").inner_text()
        assert pending_calendar, "The detail screen did not request a calendar response"
        page.context.unroute("**/api/catalog/skus/calendar?**", hold_calendar_response)
        for route in pending_calendar:
            router.handle(route)
        expect(page.locator(".detail-top-price strong")).to_contain_text("$")
        expect(page.locator(".detail-top-price .price-skeleton")).to_have_count(0)
        expect(page.locator(".detail-top-price strong")).to_have_text(re.compile(r"^\$"))
        expect(page.locator(".detail-top-price strong")).not_to_contain_text("US")
        expect(page.locator(".detail-top-price strong")).to_contain_text("50.00")
        expect(page.locator(".detail-package-price")).to_contain_text("50.00")
        expect(page.get_by_role("button", name=re.compile("今天"))).to_be_visible()
        assert router.calendar_days, "The detail screen did not request an API calendar"
        expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
        expect(page.get_by_role("button", name="所有日期", exact=True)).to_be_visible()
        expect(page.locator(".detail-sku-list, .detail-stepper")).to_have_count(0)
        sheet = open_booking_options(page)
        expect(sheet.locator(".detail-sku-list, .detail-stepper")).to_have_count(0)
        picker = open_quantity_picker(page)
        expect(page.get_by_role("dialog", name="选择人数", exact=True)).to_be_visible()
        expect(picker.locator(".detail-sku-list")).to_be_visible()
        expect(picker.locator(".detail-stepper span")).to_have_text(["0", "0", "0"])
        expect(picker.locator(".detail-picker-confirm")).to_be_disabled()
        expect(picker.locator(".detail-sku-info strong")).to_have_text(["$79.00", "$50.00", "$0.00"])
        picker.get_by_role("button", name="关闭人数选择", exact=True).click()
        date_picker = open_date_picker(page)
        pending_calendar.clear()
        page.context.route("**/api/catalog/skus/calendar?**", hold_calendar_response)
        date_picker.get_by_role("button", name="下一个月", exact=True).click()
        expect(date_picker.locator(".detail-date-loading")).to_be_visible()
        expect(date_picker.locator(".detail-date-loading")).to_have_attribute("role", "status")
        expect(date_picker.locator(".detail-date-loading span")).to_have_count(3)
        expect(date_picker.locator(".detail-picker-confirm")).to_be_disabled()
        assert "正在查询" not in page.locator("body").inner_text()
        assert "查询价格" not in page.locator("body").inner_text()
        assert pending_calendar, "Changing the month did not request a calendar response"
        page.context.unroute("**/api/catalog/skus/calendar?**", hold_calendar_response)
        for route in pending_calendar:
            router.handle(route)
        expect(date_picker.locator(".detail-date-loading")).to_have_count(0)
        expect(date_picker.locator(".detail-calendar-day:not([disabled])").first).to_be_enabled()
        date_picker.get_by_role("button", name="关闭日期选择", exact=True).click()
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_have_text("选择日期与人数")


def test_booking_sheet_preserves_selection_and_defers_availability(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        package_description = "此具体套餐包含一日入园门票及园内步行游览。"
        def product_with_package_information(route):
            product = deepcopy(EXAMPLES["product_detail"])
            product["data"]["package_list"][0]["sections"] = [
                {"title": "费用包含", "ref_field_tag": "inclusions", "content_plain": package_description}
            ]
            product["data"]["package_list"][0]["sku_list"][0]["sku_max_pax"] = 3
            router.fulfill(route, product)
        page.context.route("**/api/catalog/products/10549", product_with_package_information)
        open_detail(page, router)
        expect(page.locator(".detail-sku-list, .detail-stepper")).to_have_count(0)
        assert not router.calls("/api/availability-check"), "Viewing a product must not check availability"
        trigger = page.locator(".detail-mobile-booking").get_by_role("button", name="立即预订", exact=True)
        sheet = open_booking_options(page)
        assert not router.calls("/api/availability-check"), "Opening booking options must not check availability"
        expect(sheet.locator(".detail-sheet-selector-quantity strong")).to_have_text("请选择")
        sheet.locator(".detail-booking-sheet-footer").get_by_role("button", name="立即预订", exact=True).click()
        expect(sheet).to_be_visible()
        expect(sheet.locator(".detail-sheet-selection-note")).to_contain_text("人数")
        assert not router.calls("/api/availability-check"), "A required adult specification must still be explicitly selected"
        original_date = sheet.locator(".detail-sheet-selector-date strong").inner_text()
        date_picker = open_date_picker(page)
        expect(date_picker.locator(".detail-calendar-day[data-date]").filter(has=page.locator('span')).first).to_be_visible()
        date_picker.locator(f'.detail-calendar-day[data-date="{router.calendar_days[2]}"]').click()
        page.keyboard.press("Escape")
        sheet = page.get_by_role("dialog", name="预订选项", exact=True)
        expect(sheet.locator(".detail-sheet-selector-date strong")).to_have_text(original_date)
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_have_text("选择日期与人数")
        sheet = choose_fixture_date(page, router)
        quantity_picker = open_quantity_picker(page)
        minus = quantity_picker.get_by_role("button", name="减少Adult数量", exact=True)
        plus = quantity_picker.get_by_role("button", name="增加Adult数量", exact=True)
        expect(quantity_picker.locator(".detail-stepper span")).to_have_text("0")
        expect(minus).to_be_disabled()
        expect(quantity_picker.locator(".detail-picker-confirm")).to_be_disabled()
        plus.tap()
        expect(quantity_picker.locator(".detail-stepper span")).to_have_text("1")
        close = quantity_picker.get_by_role("button", name="关闭人数选择", exact=True)
        close.evaluate("node => node.addEventListener('click', () => { const s = getComputedStyle(node); window.touchCloseFocus = { visible: node.matches(':focus-visible'), width: s.outlineWidth, style: s.outlineStyle }; })")
        close.tap()
        touch_close = page.evaluate("window.touchCloseFocus")
        assert not touch_close["visible"], "Touch must not leave a keyboard focus ring on the close button"
        assert touch_close["width"] == "0px" or touch_close["style"] == "none", touch_close
        sheet = page.get_by_role("dialog", name="预订选项", exact=True)
        expect(sheet.locator(".detail-sheet-selector-quantity strong")).to_have_text("请选择")
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_have_text("选择日期与人数")
        quantity_picker = open_quantity_picker(page)
        expect(quantity_picker.locator(".detail-stepper span")).to_have_text("0")
        plus = quantity_picker.get_by_role("button", name="增加Adult数量", exact=True)
        plus.click()
        plus.click()
        plus.click()
        expect(quantity_picker.locator(".detail-stepper span")).to_have_text("3")
        expect(plus).to_be_disabled()
        quantity_picker.get_by_role("button", name="减少Adult数量", exact=True).click()
        expect(quantity_picker.locator(".detail-stepper span")).to_have_text("2")
        close_button = quantity_picker.get_by_role("button", name="关闭人数选择", exact=True)
        confirm = quantity_picker.locator(".detail-picker-confirm")
        close_button.focus()
        page.keyboard.press("Shift+Tab")
        expect(confirm).to_be_focused()
        page.keyboard.press("Tab")
        expect(close_button).to_be_focused()
        confirm.click()
        sheet = page.get_by_role("dialog", name="预订选项", exact=True)
        expect(sheet.locator(".detail-sheet-selector-quantity strong")).to_have_text("2 人")
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_contain_text("170")
        sheet.locator(".detail-sheet-package-heading").get_by_role("button", name="详情", exact=True).click()
        details = page.get_by_role("dialog", name="套餐详情", exact=True)
        expect(details).to_be_visible()
        expect(details.get_by_text(package_description, exact=True)).to_be_visible()
        assert not router.calls("/api/availability-check"), "Package details must not check availability"
        details.get_by_role("button", name="返回预订选项", exact=True).click()
        sheet = page.get_by_role("dialog", name="预订选项", exact=True)
        expect(sheet.locator(".detail-sheet-selector-quantity strong")).to_have_text("2 人")
        expect(sheet.locator(".detail-sheet-selector-date strong")).to_contain_text(
            f'{int(router.calendar_days[2][5:7])}月{int(router.calendar_days[2][8:])}日'
        )
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_contain_text("170")
        screenshot(page, "04-booking-sheet-official-fixture")
        page.keyboard.press("Escape")
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(trigger).to_be_focused()
        sheet = open_booking_options(page)
        expect(sheet.locator(".detail-sheet-selector-quantity strong")).to_have_text("2 人")
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_contain_text("170")
        assert not router.calls("/api/availability-check"), "Closing and reopening must not check availability"
        pending_availability = []
        def hold_availability(route):
            pending_availability.append(route)
        page.context.route("**/api/availability-check", hold_availability)
        sheet.locator(".detail-booking-sheet-footer").get_by_role("button", name="立即预订", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/booking$"))
        expect(page.locator(".booking-loading .booking-skeleton")).to_be_visible()
        expect(page.locator(".booking-skeleton")).to_have_attribute("role", "status")
        expect(page.locator(".booking-skeleton")).to_have_attribute("aria-busy", "true")
        expect(page.locator(".booking-page form, .booking-progress")).to_have_count(0)
        assert "正在确认" not in page.locator("body").inner_text()
        assert pending_availability, "The booking page did not start availability preparation"
        page.context.unroute("**/api/availability-check", hold_availability)
        for route in pending_availability:
            if route.request.failure:
                route.abort()
            else:
                router.fulfill(route, {"success": False, "error": {"code": "TEMPORARY_FAILURE", "message": "预订信息暂时无法加载，请重试。"}}, 503)
        expect(page.get_by_role("alert")).to_contain_text("暂时无法加载")
        expect(page.get_by_role("button", name="确认预订", exact=True)).to_have_count(0)
        page.get_by_role("button", name="重新加载预订信息", exact=True).click()
        expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible()
        expect(page.locator(".booking-skeleton, .booking-progress")).to_have_count(0)
        calls = router.calls("/api/availability-check")
        assert calls, "Only entering the booking page and explicitly retrying may prepare availability"
        assert calls[0]["body"][0]["sku_list"][0]["count"] == 2
        assert calls[0]["body"][0]["sku_list"][0]["price"] == "85.00"
        assert not router.calls("/api/orders/validate") and not router.calls("/api/orders")


def test_api_failure_can_recover(browser, origin):
    with mobile_page(browser, origin, fail_products=True) as (page, router):
        expect(page.get_by_text("暂时无法加载活动，请稍后重试。", exact=True)).to_be_visible()
        screenshot(page, "03-api-error-official-fixture")
        router.fail_products = False
        page.get_by_role("button", name="重新加载", exact=True).click()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()


def go_to_booking(page, router):
    open_detail(page, router)
    screenshot(page, "04-product-overview-official-fixture")
    sheet = open_booking_options(page)
    sheet = choose_fixture_date(page, router)
    quantity_picker = open_quantity_picker(page)
    expect(quantity_picker.locator(".detail-sku-info strong")).to_contain_text("85")
    expect(quantity_picker.locator(".detail-stepper span")).to_have_text("0")
    quantity_picker.get_by_role("button", name="增加Adult数量", exact=True).click()
    quantity_picker.locator(".detail-picker-confirm").click()
    screenshot(page, "04-product-detail-official-fixture")
    sheet.locator(".detail-booking-sheet-footer").get_by_role("button", name="立即预订", exact=True).click()
    expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible()
    expect(page.locator(".booking-bottom strong")).to_have_text(re.compile(r"^\$"))
    expect(page.locator(".booking-bottom strong")).not_to_contain_text("US")
    availability = router.calls("/api/availability-check")[-1]["body"]
    assert isinstance(availability, list), "Availability request must be a JSON root array"
    assert availability[0]["sku_list"][0]["price"] == "85.00"


def fill_booking(page, with_traveller_fields=True):
    page.locator('input[name="family_name"]').fill("ZHANG")
    page.locator('input[name="first_name"]').fill("WEI")
    page.locator('input[name="mobile"]').fill("13800000000")
    page.get_by_label(re.compile(r"^Full Name")).fill("张伟")
    phone_field = page.locator("label.field-label").filter(has_text="Phone Number")
    phone_field.locator("select").select_option("86")
    phone_field.locator("input").fill("13800000000")
    if with_traveller_fields:
        page.get_by_label(re.compile(r"^ID Type")).select_option("passport")
        expect(page.get_by_label(re.compile(r"^Passport Number"))).to_be_visible()
        page.get_by_label(re.compile(r"^Passport Number")).fill("TEST123456")
    page.get_by_role("checkbox").check()


def assert_order_payload(router, expected_price="85.00", expected_count=1, with_traveller_fields=True):
    payload = router.calls("/api/orders")[-1]["body"]
    contact = payload["contact_info"]
    assert contact["first_name"] == "WEI" and contact["family_name"] == "ZHANG"
    assert contact["mobile"] == "86-13800000000"
    assert "name_english" not in contact, "Contact rules are not request field names"
    item = payload["items"][0]
    assert item["package_code"] == "90010001"
    assert item["sku_list"][0]["sku_code"] == "200100001"
    assert item["sku_list"][0]["acceptable_price"] == expected_price
    assert item["sku_list"][0]["count"] == expected_count
    assert payload["expected_currency"] == "USD"
    assert Decimal(payload["expected_total"]) == Decimal(expected_price) * expected_count
    fields = {entry["key"]: entry for entry in item["booking_extra_info"]}
    assert fields["local_full_name"] == {"key": "local_full_name", "content": "张伟"}
    assert fields["mobile"] == {"key": "mobile", "content": "86-13800000000"}, "A country selection cannot replace the actual phone number"
    travellers = item["unit_extra_info"]
    assert len(travellers) == expected_count
    for index, traveller in enumerate(travellers, start=1):
        assert traveller["sku_code"] == "200100001"
        assert traveller["index"] == index
        assert "unit_index" not in traveller
        if with_traveller_fields:
            # This nested passport shape is inferred from the official rule
            # tree; only direct text/select wire answers have live validation.
            assert traveller["extra_info"] == [{"key": "identification_type", "selected": [
                {"key": "passport", "content": "", "selected": [
                    {"key": "passport_number", "content": "TEST123456"}
                ]}
            ]}]
        else:
            assert traveller["extra_info"] == []


def assert_demo_cashier(page):
    expect(page).to_have_url(re.compile(r"/#/cashier$"))
    expect(page.locator(".confirmation-page .simple-topbar")).to_contain_text("收银台")
    expect(page.locator(".confirmation-page .ant-badge")).to_have_text("DEMO")
    expect(page.get_by_text("尚未生成正式订单或收取费用。支付及后续功能沿用 RollingGo 现有流程。", exact=True)).to_be_visible()
    expect(page.locator(".checkout-link")).to_have_count(0)


def test_calendar_dynamic_fields_and_order_draft(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        go_to_booking(page, router)
        submit = page.get_by_role("button", name="确认预订", exact=True)
        submit.click()
        assert not router.calls("/api/orders/validate"), "Empty mandatory fields must block submission"
        fill_booking(page)
        page.locator('input[name="first_name"]').fill("伟")
        submit.click()
        assert not router.calls("/api/orders/validate"), "English-name rule must block non-English text"
        page.locator('input[name="first_name"]').fill("WEI")
        passport = page.get_by_label(re.compile(r"^Passport Number"))
        passport.fill("")
        submit.click()
        assert not router.calls("/api/orders/validate"), "Nested traveller requirements must block submission"
        passport.fill("TEST123456")
        prepared = len(router.calls("/api/availability-check"))
        product_reads = len(router.calls("/api/catalog/products/10549"))
        page.get_by_role("button", name="修改出行日期", exact=True).click()
        editor = page.locator(".detail-picker-sheet.date")
        expect(editor).to_be_visible()
        editor.locator(f'.detail-calendar-day[data-date="{router.calendar_days[0]}"]').click()
        page.keyboard.press("Escape")
        expect(page.locator(".booking-bottom strong")).to_contain_text("85")
        assert len(router.calls("/api/availability-check")) == prepared, "Cancelling an edit must not prepare a new quote"
        expect(page.locator('input[name="first_name"]')).to_have_value("WEI")
        page.get_by_role("button", name="修改出行日期", exact=True).click()
        editor = page.locator(".detail-picker-sheet.date")
        editor.locator(f'.detail-calendar-day[data-date="{router.calendar_days[0]}"]').click()
        editor.locator(".detail-picker-confirm").click()
        expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible()
        expect(page.locator(".booking-bottom strong")).to_contain_text("79")
        expect(page.get_by_role("checkbox")).not_to_be_checked()
        refreshed = router.calls("/api/availability-check")[-1]["body"][0]
        assert refreshed["start_time"].startswith(router.calendar_days[0])
        assert refreshed["sku_list"][0]["count"] == 1
        page.get_by_role("button", name="修改预订人数", exact=True).click()
        editor = page.locator(".detail-picker-sheet.quantity")
        expect(editor.locator(".detail-stepper span")).to_have_text("1")
        editor.get_by_role("button", name="增加Adult数量", exact=True).click()
        editor.locator(".detail-picker-confirm").click()
        expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible()
        expect(page.locator(".booking-bottom strong")).to_contain_text("158")
        refreshed = router.calls("/api/availability-check")[-1]["body"][0]
        assert refreshed["start_time"].startswith(router.calendar_days[0])
        assert refreshed["sku_list"][0]["count"] == 2 and refreshed["sku_list"][0]["price"] == "79.00"
        assert len(router.calls("/api/catalog/products/10549")) == product_reads, "Editing reuses the loaded product"
        for name, value in [("family_name", "ZHANG"), ("first_name", "WEI"), ("mobile", "13800000000")]:
            expect(page.locator(f'input[name="{name}"]')).to_have_value(value)
        expect(page.get_by_label(re.compile(r"^Full Name"))).to_have_value("张伟")
        expect(page.locator("label.field-label").filter(has_text="Phone Number").locator("input")).to_have_value("13800000000")
        traveller_1 = page.locator("section.form-card").filter(has=page.get_by_role("heading", name=re.compile(r"^旅客 1")))
        expect(traveller_1.get_by_label(re.compile(r"^Passport Number"))).to_have_value("TEST123456")
        traveller_2 = page.locator("section.form-card").filter(has=page.get_by_role("heading", name=re.compile(r"^旅客 2")))
        traveller_2.get_by_label(re.compile(r"^ID Type")).select_option("passport")
        traveller_2.get_by_label(re.compile(r"^Passport Number")).fill("TEST123456")
        for width in [320, 393, 744]:
            page.set_viewport_size({"width": width, "height": 844})
            page.get_by_role("combobox", name="国际电话区号", exact=True).select_option("852")
            expect(page.locator('input[name="mobile"]')).to_have_value("13800000000")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth + 1"), f"Booking overflows at {width}px"
            for field in page.locator(".phone-field").all():
                geometry = field.evaluate("node => { const r = node.getBoundingClientRect(); const controls = [...node.querySelectorAll('input, select')].map(c => { const b = c.getBoundingClientRect(); return { left:b.left, right:b.right, width:b.width }; }); return { left:r.left, right:r.right, controls }; }")
                assert all(c["left"] >= geometry["left"] - 1 and c["right"] <= geometry["right"] + 1 and c["width"] > 0 for c in geometry["controls"]), (width, geometry)
                assert geometry["controls"][0]["right"] <= geometry["controls"][1]["left"] + 1, (width, geometry)
            page.get_by_role("combobox", name="国际电话区号", exact=True).select_option("86")
        page.set_viewport_size({"width": 390, "height": 844})
        page.get_by_role("checkbox").check()
        screenshot(page, "05-booking-official-fixture")
        pending_submission = []
        def hold_submit_availability(route):
            pending_submission.append(route)
        page.context.route("**/api/availability-check", hold_submit_availability)
        submit.click()
        expect(submit.locator(".price-skeleton")).to_be_visible()
        expect(submit).to_be_disabled()
        expect(page.locator('input[name="first_name"]')).to_be_disabled()
        assert "正在确认" not in page.locator("body").inner_text()
        assert pending_submission, "Confirming must refresh the current availability"
        page.context.unroute("**/api/availability-check", hold_submit_availability)
        for route in pending_submission:
            if route.request.failure:
                route.abort()
            else:
                router.handle(route)
        expect(page.get_by_role("heading", name="预订信息已确认", exact=True)).to_be_visible()
        assert_demo_cashier(page)
        expect(page.locator(".receipt-total strong")).to_have_text(re.compile(r"^\$"))
        expect(page.locator(".receipt-total strong")).not_to_contain_text("US")
        expect(page.get_by_text("ANT-browser-test", exact=True)).to_be_visible()
        assert len(router.calls("/api/orders")) == 1
        assert_order_payload(router, expected_price="79.00", expected_count=2)
        assert router.calls("/api/orders")[-1]["body"]["items"][0]["start_time"].startswith(router.calendar_days[0])
        expect(page.locator(".receipt-total strong")).to_contain_text("158")
        expect(page.locator(".receipt-row").filter(has_text="出行日期")).to_contain_text(router.calendar_days[0])
        assert not any("/pay" in entry["path"] for entry in router.requests)
        screenshot(page, "06-confirmation-official-fixture")


def test_price_increase_requires_confirmation(browser, origin):
    with mobile_page(browser, origin, price_change=True) as (page, router):
        go_to_booking(page, router)
        fill_booking(page)
        page.get_by_role("button", name="确认预订", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("价格已更新")
        expect(page.locator(".booking-bottom strong")).to_contain_text("91")
        assert not router.calls("/api/orders"), "A changed quote must not submit before a second confirmation"
        screenshot(page, "07-price-reconfirmation-official-fixture")
        page.get_by_role("button", name="确认更新后的价格", exact=True).click()
        expect(page.get_by_role("heading", name="预订信息已确认", exact=True)).to_be_visible()
        assert_demo_cashier(page)
        assert len(router.calls("/api/orders")) == 1
        assert_order_payload(router, "91.00")


def test_validation_quote_requires_confirmation(browser, origin):
    with mobile_page(browser, origin, quote_change_only=True) as (page, router):
        go_to_booking(page, router)
        fill_booking(page)
        page.get_by_role("button", name="确认预订", exact=True).click()
        expect(page.get_by_role("alert")).to_contain_text("价格已更新")
        expect(page.locator(".booking-bottom strong")).to_contain_text("91")
        assert len(router.calls("/api/orders/validate")) == 1
        assert not router.calls("/api/orders"), "A changed validation quote needs a second confirmation"
        page.get_by_role("button", name="确认更新后的价格", exact=True).click()
        expect(page.get_by_role("heading", name="预订信息已确认", exact=True)).to_be_visible()
        assert_demo_cashier(page)
        assert len(router.calls("/api/orders")) == 1
        assert_order_payload(router, "91.00")


def test_empty_unit_rules_still_send_each_traveller(browser, origin):
    with mobile_page(browser, origin, empty_unit_rules=True) as (page, router):
        open_detail(page, router)
        sheet = open_booking_options(page)
        sheet = choose_fixture_date(page, router)
        quantity_picker = open_quantity_picker(page)
        quantity_picker.get_by_role("button", name="增加Adult数量", exact=True).click()
        quantity_picker.get_by_role("button", name="增加Adult数量", exact=True).click()
        quantity_picker.locator(".detail-picker-confirm").click()
        expect(sheet.locator(".detail-booking-sheet-footer strong")).to_contain_text("170")
        sheet.locator(".detail-booking-sheet-footer").get_by_role("button", name="立即预订", exact=True).click()
        expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name=re.compile(r"^旅客"))).to_have_count(0)
        fill_booking(page, with_traveller_fields=False)
        page.get_by_role("button", name="确认预订", exact=True).click()
        expect(page.get_by_role("heading", name="预订信息已确认", exact=True)).to_be_visible()
        assert_demo_cashier(page)
        assert_order_payload(router, expected_count=2, with_traveller_fields=False)


TESTS = [test_search_page_and_simple_destination_search,
         test_chinese_labels_and_committed_destination,
         test_list_reload_history_and_product_return,
         test_search_reload_and_close_returns_originating_list,
         test_search_keyword_can_search_all_activities,
         test_search_category_suggestion_submits_immediately,
         test_empty_results_can_clear_committed_keyword,
         test_direct_product_link_returns_home,
         test_catalog_starting_price_and_detail_without_favorites,
         test_booking_sheet_preserves_selection_and_defers_availability,
         test_api_failure_can_recover,
         test_calendar_dynamic_fields_and_order_draft,
         test_price_increase_requires_confirmation,
         test_validation_quote_requires_confirmation,
         test_empty_unit_rules_still_send_each_traveller]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5173")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    args = parser.parse_args()
    failures = 0
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(executable_path=args.chromium, headless=True,
                                              args=["--no-sandbox"])
        for test in TESTS:
            try:
                test(browser, args.base_url.rstrip("/"))
                print(f"PASS {test.__name__}")
            except Exception:
                failures += 1
                print(f"FAIL {test.__name__}")
                traceback.print_exc()
        browser.close()
    print(f"Official-example mobile checks: {len(TESTS) - failures}/{len(TESTS)} passed. These are not live supplier checks.")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
