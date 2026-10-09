#!/usr/bin/env python3
"""Mobile interaction checks with isolated official-example API responses.

Run against the local dev server. All /api requests are intercepted, including
POSTs, so this script cannot create a supplier order or call payment endpoints.
"""

import argparse
from contextlib import contextmanager
from decimal import Decimal
from pathlib import Path
import re
import sys
import traceback
from urllib.parse import parse_qs, urlparse

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
    expect(page.get_by_role("heading", name="活动列表", exact=True)).to_be_visible()
    expect(page.get_by_role("heading", name="东京活动", exact=True)).to_be_visible()
    expect(page.locator(".cat-hero")).to_have_count(0)
    expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
    assert router.calls("/api/catalog/products")[-1]["params"]["city_codes"] == ["215"]


def open_detail(page, router):
    search_destination(page, router)
    page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
    expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
    expect(page.locator(".detail-calendar-note")).to_contain_text("USD")
    assert router.calendar_days, "The detail screen did not request an API calendar"


def test_search_page_and_simple_destination_search(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        expect(page.get_by_role("tab", name="活动", exact=True)).to_have_attribute("aria-selected", "true")
        expect(page.get_by_role("tab", name="酒店", exact=True).locator("svg")).to_have_count(0)
        expect(page.get_by_role("tab", name="机票", exact=True).locator("svg")).to_have_count(0)
        expect(page.get_by_role("tab", name="活动", exact=True).locator("svg")).to_have_count(0)
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
        expect(page.get_by_role("heading", name="东京活动", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_have_count(0)
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        params = router.calls("/api/catalog/products")[-1]["params"]
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
                  {"category_code": "20102", "category_name": "Cruise"}]
    with mobile_page(browser, origin, categories=categories, cities=cities) as (page, router):
        expect(page.get_by_role("button", name="邮轮", exact=True)).to_be_visible()
        search_destination(page, router)
        expect(page.locator(".cat-product-location")).to_have_text("东京 · 日本")
        expect(page.locator(".cat-product-category")).to_have_text("主题乐园")
        page.get_by_role("button", name="修改搜索", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        search_box(page).fill("京都")
        city = page.locator('.ant-search-city[data-city-code="216"]')
        expect(city).to_contain_text("京都")
        expect(city).to_contain_text("日本")
        city.click()
        expect(page).to_have_url(re.compile(r"/#/activities\?city=216(?:&|$)"))
        expect(page.get_by_role("heading", name="京都活动", exact=True)).to_be_visible()
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        assert router.calls("/api/catalog/products")[-1]["params"]["city_codes"] == ["216"]
        page.get_by_role("button", name="主题乐园", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/activities\?.*&category=20101(?:&|$)"))
        expect(page.get_by_role("heading", name="京都 · 主题乐园", exact=True)).to_be_visible()
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        assert router.calls("/api/catalog/products")[-1]["params"]["category_codes"] == ["20101"]
        category_list = page.url
        page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
        page.get_by_role("button", name="返回活动列表", exact=True).click()
        expect(page).to_have_url(category_list)
        expect(page.get_by_role("button", name="主题乐园", exact=True)).to_have_class(re.compile(r"selected"))
        page.get_by_role("button", name="全部体验", exact=True).click()
        expect(page.get_by_role("heading", name="京都活动", exact=True)).to_be_visible()
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        assert "category" not in parse_qs(urlparse(page.url).fragment.split("?", 1)[1])


def test_list_reload_history_and_product_return(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        search_destination(page, router)
        initial_list = page.url
        page.get_by_role("button", name="修改搜索", exact=True).click()
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
        expect(page.get_by_role("heading", name="“游船”的搜索结果", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="修改搜索", exact=True)).to_contain_text("游船")
        assert router.calls("/api/catalog/products")[-1]["params"]["keyword"] == ["游船"]
        page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        page.get_by_role("button", name="返回活动列表", exact=True).click()
        expect(page).to_have_url(committed_list)
        expect(page.get_by_role("heading", name="“游船”的搜索结果", exact=True)).to_be_visible()
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
        expect(page.get_by_role("heading", name="东京活动", exact=True)).to_be_visible()


def test_search_reload_and_close_returns_originating_list(browser, origin):
    with mobile_page(browser, origin, categories=[{"category_code": "20101", "category_name": "Theme Parks"}]) as (page, router):
        search_destination(page, router)
        page.get_by_role("button", name="主题乐园", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/activities\?.*&category=20101(?:&|$)"))
        original_list = page.url
        page.get_by_role("button", name="修改搜索", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        search_url = page.url
        page.reload(wait_until="networkidle")
        expect(page).to_have_url(search_url)
        page.get_by_role("button", name="关闭搜索", exact=True).click()
        expect(page).to_have_url(original_list)
        expect(page.get_by_role("button", name="主题乐园", exact=True)).to_have_class(re.compile(r"selected"))


def test_search_keyword_can_search_all_activities(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        page.get_by_role("button", name="搜索目的地/活动", exact=True).click()
        expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
        search_box(page).fill("游船")
        search_box(page).press("Enter")
        expect(page).to_have_url(re.compile(r"/#/activities\?q="))
        expect(page.get_by_role("heading", name="“游船”的搜索结果", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        params = router.calls("/api/catalog/products")[-1]["params"]
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
        category.click()
        expect(page).to_have_url(re.compile(r"/#/activities\?city=215.*&category=20101(?:&|$)"))
        expect(page.get_by_role("heading", name="东京 · 主题乐园", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        params = router.calls("/api/catalog/products")[-1]["params"]
        assert params["city_codes"] == ["215"]
        assert params["category_codes"] == ["20101"]


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
        page.get_by_role("button", name="修改搜索", exact=True).click()
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
    with mobile_page(browser, origin) as (page, router):
        expect(page.locator(".cat-product-price, .cat-see-price, .cat-price-retry")).to_have_count(0)
        assert not router.calls("/api/catalog/prices"), "Homepage recommendations must not request prices"
        search_destination(page, router)
        expect(page.locator(".cat-product-card .cat-product-price")).to_have_text(re.compile(r".*79\.00\s*起$"))
        expect(page.get_by_text("选择套餐查看价格", exact=True)).to_have_count(0)
        assert router.calls("/api/catalog/prices")[-1]["params"]["product_codes"] == ["10549"]
        page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
        expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
        expect(page.locator(".detail-calendar-note")).to_contain_text("USD")
        assert router.calendar_days, "The detail screen did not request an API calendar"
        expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
        expect(page.get_by_role("button", name="所有日期", exact=True)).to_be_visible()
        expect(page.get_by_role("heading", name="选择数量", exact=True)).to_be_visible()


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
    page.get_by_role("button", name="所有日期", exact=True).click()
    sold_out = page.locator(".detail-calendar").get_by_role("button", name=re.compile(f"^{router.calendar_days[1]}，"))
    expect(sold_out).to_be_disabled()
    bookable = page.locator(".detail-calendar").get_by_role("button", name=re.compile(f"^{router.calendar_days[2]}，"))
    expect(bookable).to_be_enabled()
    expect(bookable).to_have_attribute("aria-label", re.compile(r"85"))
    bookable.click()
    expect(page.locator(".detail-sku-info strong")).to_contain_text("85")
    expect(page.locator(".detail-mobile-booking strong")).to_contain_text("85")
    screenshot(page, "04-product-detail-official-fixture")
    page.locator(".detail-mobile-booking").get_by_role("button", name="立即预订", exact=True).click()
    expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible()
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
        screenshot(page, "05-booking-official-fixture")
        submit.click()
        expect(page.get_by_role("heading", name="预订信息已确认", exact=True)).to_be_visible()
        assert_demo_cashier(page)
        expect(page.get_by_text("ANT-browser-test", exact=True)).to_be_visible()
        assert len(router.calls("/api/orders")) == 1
        assert_order_payload(router)
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
        page.get_by_role("button", name="所有日期", exact=True).click()
        page.locator(".detail-calendar").get_by_role("button", name=re.compile(f"^{router.calendar_days[2]}，")).click()
        page.get_by_role("button", name="增加Adult数量", exact=True).click()
        expect(page.locator(".detail-mobile-booking strong")).to_contain_text("170")
        page.locator(".detail-mobile-booking").get_by_role("button", name="立即预订", exact=True).click()
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
