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

from playwright.sync_api import expect, sync_playwright

from fixture_router import EXAMPLES, FixtureRouter


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts" / "browser"
TITLE = EXAMPLES["products"]["data"]["products"][0]["title"]


@contextmanager
def mobile_page(browser, origin, **variants):
    context = browser.new_context(viewport={"width": 390, "height": 844},
                                  device_scale_factor=1, is_mobile=True,
                                  has_touch=True, locale="zh-CN",
                                  timezone_id="Europe/London")
    router = FixtureRouter(origin, **variants)
    router.install(context)
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


def choose_destination(page):
    page.get_by_role("button", name=re.compile(r"^目的地.*必填")).click()
    dialog = page.get_by_role("dialog", name="想去哪里？")
    dialog.get_by_role("button", name=re.compile(r"Tokyo.*Japan")).click()


def search_destination(page, router):
    choose_destination(page)
    page.locator(".cat-search-panel").get_by_role("button", name="查询", exact=True).click()
    expect(page.get_by_role("heading", name=re.compile(r"Tokyo · 活动体验"))).to_be_visible()
    expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
    assert router.calls("/api/catalog/products")[-1]["params"]["city_codes"] == ["215"]


def open_detail(page, router):
    search_destination(page, router)
    page.get_by_role("button", name=f"查看 {TITLE}", exact=True).click()
    expect(page.get_by_role("heading", name=TITLE, exact=True)).to_be_visible()
    expect(page.locator(".detail-calendar-note")).to_contain_text("USD")
    assert router.calendar_days, "The detail screen did not request an API calendar"


def test_required_destination_and_simple_search(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        expect(page.get_by_role("tab", name="活动", exact=True)).to_have_attribute("aria-selected", "true")
        expect(page.get_by_role("button", name=re.compile(r"^出行日期"))).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile(r"^人数"))).to_have_count(0)
        expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
        expect(page.get_by_text("选择目的地即可出发，日期和人数稍后再定。", exact=True)).to_have_count(0)
        screenshot(page, "01-home-official-fixture")
        before = len(router.calls("/api/catalog/products"))
        page.locator(".cat-search-panel").get_by_role("button", name="查询", exact=True).click()
        expect(page.get_by_role("alert")).to_have_text("请先选择一个目的地")
        assert len(router.calls("/api/catalog/products")) == before
        page.get_by_role("dialog").get_by_role("button", name=re.compile(r"Tokyo.*Japan")).click()
        # Wait for the new destination response before inspecting its image.
        # The previous catalogue uses the same fixture title and is replaced
        # while a smooth scroll is still settling.
        with page.expect_response(lambda response: "/api/catalog/products?" in response.url
                                  and "city_codes=215" in response.url):
            page.locator(".cat-search-panel").get_by_role("button", name="查询", exact=True).click()
        expect(page.get_by_label("正在加载活动", exact=True)).to_have_count(0)
        expect(page.get_by_role("heading", name=re.compile(r"Tokyo · 活动体验"))).to_be_visible()
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


def test_catalog_starting_price_and_detail_without_favorites(browser, origin):
    with mobile_page(browser, origin) as (page, router):
        expect(page.locator(".cat-product-card .cat-product-price")).to_have_text(re.compile(r".*79\.00\s*起$"))
        expect(page.get_by_text("选择套餐查看价格", exact=True)).to_have_count(0)
        assert router.calls("/api/catalog/prices")[-1]["params"]["product_codes"] == ["10549"]
        open_detail(page, router)
        expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
        expect(page.get_by_role("heading", name="选择日期", exact=True)).to_be_visible()
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
    sold_out = page.get_by_role("button", name=re.compile(f"^{router.calendar_days[1]}，"))
    expect(sold_out).to_be_disabled()
    bookable = page.get_by_role("button", name=re.compile(f"^{router.calendar_days[2]}，"))
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
        page.get_by_role("button", name=re.compile(f"^{router.calendar_days[2]}，")).click()
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


TESTS = [test_required_destination_and_simple_search,
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
