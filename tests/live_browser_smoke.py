#!/usr/bin/env python3
"""Read-only live mobile smoke test; stops at the empty booking form.

The browser blocks order validation, order creation, payments and every other
API POST except the explicitly allowed read-only availability check.
Managed Chromium needs access to its existing NSS database; request controlled
filesystem access through the runner when sandbox restrictions prevent it.
TLS verification stays enabled and this script never changes certificate trust.
"""

import argparse
import json
import os
from pathlib import Path
import re
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts" / "browser"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:5175")
    parser.add_argument("--product-code", default="105")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    args = parser.parse_args()
    origin = args.base_url.rstrip("/")
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    report = {"mode": "live-read-only", "api_calls": [], "api_errors": [], "blocked": [],
              "failed_images": [], "console_errors": [], "page_errors": [], "catalog_starting_prices": {}}
    api_data = {}

    def guard(route):
        request = route.request
        parsed = urlparse(request.url)
        if request.method not in {"GET", "HEAD"} and not (
            f"{parsed.scheme}://{parsed.netloc}" == origin
            and parsed.path == "/api/availability-check" and request.method == "POST"
        ):
            report["blocked"].append({"method": request.method, "path": parsed.path})
            route.abort()
            return
        if parsed.path.startswith("/api/"):
            if not (parsed.path.startswith("/api/catalog/") or parsed.path in {"/api/health", "/api/availability-check"}):
                report["blocked"].append({"method": request.method, "path": parsed.path})
                route.abort()
                return
            report["api_calls"].append({"method": request.method, "path": parsed.path,
                                        "params": parse_qs(parsed.query)})
        route.continue_()

    def response_received(response):
        parsed = urlparse(response.url)
        if f"{parsed.scheme}://{parsed.netloc}" != origin or not parsed.path.startswith("/api/"):
            return
        try:
            payload = response.json()
            api_data[parsed.path] = payload
            if parsed.path == "/api/catalog/prices" and payload.get("success"):
                for price in payload.get("data", {}).get("prices", []):
                    report["catalog_starting_prices"][price["product_code"]] = price
            if not response.ok or payload.get("success") is False:
                report["api_errors"].append({"path": parsed.path, "status": response.status,
                                             "code": payload.get("error", {}).get("code"),
                                             "trace_id": payload.get("error", {}).get("trace_id")})
        except Exception:
            pass

    def request_failed(request):
        if request.resource_type == "image":
            parsed = urlparse(request.url)
            report["failed_images"].append({"host": parsed.netloc, "path": parsed.path,
                                            "failure": request.failure})

    def save(page, name):
        page.screenshot(path=str(ARTIFACTS / f"{name}-live.png"), full_page=True)
        page.screenshot(path=str(ARTIFACTS / f"{name}-live.viewport.png"), full_page=False)

    proxy_server = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    options = {"executable_path": args.chromium, "headless": True, "args": ["--no-sandbox"]}
    if proxy_server:
        options["proxy"] = {"server": proxy_server, "bypass": "127.0.0.1,localhost"}

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**options)
        context = browser.new_context(viewport={"width": 390, "height": 844},
                                      device_scale_factor=1, is_mobile=True,
                                      has_touch=True, locale="zh-CN", timezone_id="Europe/London")
        context.route("**/*", guard)
        page = context.new_page()
        page.on("response", response_received)
        page.on("requestfailed", request_failed)
        page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        page.on("console", lambda message: report["console_errors"].append(message.text[:300])
                if message.type == "error" else None)
        try:
            page.goto(origin, wait_until="domcontentloaded")
            expect(page.locator(".cat-product-card").first).to_be_visible(timeout=30000)
            expect(page.get_by_role("heading", name="热门推荐", exact=True)).to_be_visible()
            expect(page.get_by_role("tab", name="酒店", exact=True).locator("svg")).to_have_count(0)
            expect(page.get_by_role("tab", name="机票", exact=True).locator("svg")).to_have_count(0)
            expect(page.get_by_role("tab", name="活动", exact=True).locator("svg")).to_have_count(0)
            expect(page.get_by_text("必填", exact=True)).to_have_count(0)
            expect(page.locator(".cat-destinations, .cat-result-count, .cat-bottom-nav")).to_have_count(0)
            expect(page.locator(".cat-category-row button").first).to_be_visible(timeout=30000)
            for option in page.locator(".cat-category-row button").all_text_contents():
                assert not re.search(r"[A-Za-z]", option), f"Category is not Chinese: {option}"
            for location in page.locator(".cat-product-location").all_text_contents():
                assert not re.search(r"[A-Za-z]", location), f"Location is not Chinese: {location}"
            products = api_data["/api/catalog/products"]["data"]["products"]
            product = next(item for item in products if str(item["product_code"]) == args.product_code)
            title = product["title"]
            report["product_code"] = args.product_code
            report["product_title"] = title
            report["catalog_total"] = api_data["/api/catalog/products"]["data"]["total"]
            expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
            expect(page.get_by_role("button", name=re.compile(r"^出行日期"))).to_have_count(0)
            expect(page.get_by_role("button", name=re.compile(r"^人数"))).to_have_count(0)
            card = page.locator(".cat-product-card").filter(has=page.get_by_role("heading", name=title, exact=True))
            expect(card.locator(".cat-product-price")).to_contain_text("起", timeout=90000)
            starting_price = report["catalog_starting_prices"].get(args.product_code)
            assert starting_price and starting_price["status"] == "ready", "No real starting price returned for this product"
            report["catalog_starting_price"] = starting_price
            save(page, "08-home")
            page.get_by_role("button", name="搜索目的地/活动", exact=True).click()
            expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
            page.get_by_role("textbox", name="搜索目的地/活动", exact=True).fill(product["city_name"])
            city_button = page.locator(f'.ant-search-city[data-city-code="{product["city_code"]}"]')
            expect(city_button).to_be_visible(timeout=30000)
            cities = api_data["/api/catalog/cities"]["data"]
            report["city_count"] = len(cities)
            assert not re.search(r"[A-Za-z]", city_button.inner_text()), "Destination label is not Chinese"
            city_button.click()
            expect(page).to_have_url(re.compile(r"/#/activities\?city="))
            expect(page.get_by_role("heading", name="活动列表", exact=True)).to_be_visible()
            expect(page.locator(".cat-hero, .cat-bottom-nav")).to_have_count(0)
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=30000)
            list_url = page.url
            report["list_url"] = list_url
            page.reload(wait_until="domcontentloaded")
            expect(page).to_have_url(list_url)
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=30000)
            page.get_by_role("button", name="修改搜索", exact=True).click()
            expect(page).to_have_url(re.compile(r"/#/search(?:\?|$)"))
            search_url = page.url
            page.reload(wait_until="domcontentloaded")
            expect(page).to_have_url(search_url)
            page.get_by_role("button", name="关闭搜索", exact=True).click()
            expect(page).to_have_url(list_url)
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=30000)
            page.get_by_role("heading", name=title, exact=True).scroll_into_view_if_needed()
            save(page, "09-catalog")
            page.get_by_role("button", name=f"查看 {title}", exact=True).click()
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=30000)
            expect(page.locator(".detail-calendar-note")).to_contain_text("USD", timeout=30000)
            expect(page.get_by_role("button", name=re.compile(r"收藏"))).to_have_count(0)
            page.get_by_role("button", name="返回活动列表", exact=True).click()
            expect(page).to_have_url(list_url)
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=30000)
            page.get_by_role("button", name=f"查看 {title}", exact=True).click()
            expect(page.locator(".detail-calendar-note")).to_contain_text("USD", timeout=30000)
            save(page, "10-product")
            available = page.locator(".detail-calendar-day:not([disabled])")
            assert available.count() > 0, "No real bookable date returned for this product"
            available.first.click()
            expect(page.locator(".detail-sku-info strong").first).to_contain_text("US$")
            detail = api_data[f"/api/catalog/products/{args.product_code}"]["data"]
            selected = detail["package_list"][0]
            report["product_reference_price"] = detail.get("price")
            report["sku_titles"] = page.locator(".detail-sku-row h4").all_text_contents()
            required_count = max(1, int(selected.get("package_min_pax") or 0))
            adult_row = page.locator(".detail-sku-row").first
            count = int(adult_row.locator(".detail-stepper span").inner_text())
            for _ in range(max(0, required_count - count)):
                adult_row.get_by_role("button", name=re.compile(r"^增加")).click()
            save(page, "11-calendar")
            page.locator(".detail-mobile-booking").get_by_role("button", name="立即预订", exact=True).click()
            expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible(timeout=30000)
            expect(page.get_by_role("heading", name="预订补充信息", exact=True)).to_be_visible()
            if any(rule.get("key") == "email" and rule.get("required") for rule in selected.get("contact_info", [])):
                expect(page.locator('input[name="email"]')).to_have_attribute("required", "")
            report["booking_form_reached"] = True
            report["contact_fields_empty"] = all(
                page.locator(f'input[name="{name}"]').input_value() == ""
                for name in ["first_name", "family_name", "mobile", "email"]
            )
            messaging = page.get_by_label(re.compile(r"^Messaging app"))
            messaging.select_option("contact_way_no_whatsapp")
            report["whatsapp_number_input_rendered"] = page.get_by_label(re.compile(r"^WhatsApp")).count() > 0
            expect(page.get_by_label(re.compile(r"^WhatsApp"))).to_be_visible()
            save(page, "12-booking")
            report["mobile_overflow"] = page.evaluate("document.documentElement.scrollWidth > innerWidth + 1")
            booking_image = page.locator(".booking-summary img")
            report["detail_image_loaded"] = booking_image.count() > 0 and booking_image.evaluate("node => node.naturalWidth > 0")
            report["booking_image_fallback_visible"] = page.locator('.booking-image [aria-label="商品图片暂不可用"]').is_visible()
            assert report["contact_fields_empty"], "Smoke test must leave contact fields empty"
            assert not report["blocked"], "The UI attempted a prohibited operation"
            assert not report["page_errors"], report["page_errors"]
            assert not report["mobile_overflow"], "Mobile page overflows"
            summary = {key: report[key] for key in ["mode", "product_code", "product_title", "catalog_total", "city_count", "catalog_starting_price",
                                                   "booking_form_reached", "contact_fields_empty", "whatsapp_number_input_rendered",
                                                   "detail_image_loaded", "booking_image_fallback_visible", "mobile_overflow", "api_errors", "blocked", "page_errors"]}
            summary["image_failure_count"] = len(report["failed_images"])
            summary["image_failure_hosts"] = sorted({entry["host"] for entry in report["failed_images"]})
            summary["console_error_count"] = len(report["console_errors"])
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            print("PASS live-read-only flow reached booking; no order validation, creation or payment was requested.")
        except Exception:
            save(page, "13-blocked-state")
            raise
        finally:
            (ARTIFACTS / "live-read-only-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
