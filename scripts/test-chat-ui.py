"""Browser regressions against an isolated real server and fixture providers.
Requires Python Playwright and Chromium. No provider login or model calls.
"""
import json
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
server = subprocess.Popen(
    ["node", "test/fixtures/ui-server.mjs"], cwd=ROOT,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
try:
    boot = json.loads(server.stdout.readline())
    base, token = boot["url"].split("/#token=")
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

    def api(route, data=None):
        req = Request(base + "/api" + route, headers=headers, data=None if data is None else json.dumps(data).encode())
        with urlopen(req, timeout=10) as response:
            return json.load(response)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(boot["url"])
        page.get_by_text("Connected locally", exact=True).wait_for()

        def choose(title):
            page.get_by_role("button", name=title, exact=False).click()
            expect(page.locator("#detail-title")).to_have_text(title)

        def create(title, start=False):
            page.locator("#new-task").click()
            page.locator("#new-title").fill(title)
            page.locator("#new-project").fill(boot["project"])
            page.locator("#new-prompt").fill("Fixture task for browser verification.")
            page.locator("#new-agent").select_option("codex")
            page.locator("#new-permission").select_option("read-only")
            if start:
                page.get_by_role("button", name="Create & run", exact=False).click()
            else:
                page.locator("#create-only").click()
            expect(page.locator("#detail-title")).to_have_text(title)
            return next(t for t in api("/tasks")["tasks"] if t["title"] == title)

        findings = {}
        page.locator("#new-task").click()
        page.locator("#new-title").fill("Exploratory chat")
        page.locator("#create-only").click()
        expect(page.locator("#detail-title")).to_have_text("Exploratory chat")
        chat = next(t for t in api("/tasks")["tasks"] if t["title"] == "Exploratory chat")
        page.locator("#run-agent").select_option("codex")
        page.locator("#run-model").fill("cheap-fixture-model")
        page.locator("#run-agent").select_option("claude")
        page.locator("#run-agent").select_option("codex")
        findings["preserves_selected_model"] = page.locator("#run-model").input_value() == "cheap-fixture-model"
        page.locator("#run-note").fill("Keep this unsent message.")
        choose("Existing task")
        choose("Exploratory chat")
        findings["preserves_unsent_message"] = page.locator("#run-note").input_value() == "Keep this unsent message."
        page.reload()
        page.get_by_text("Connected locally", exact=True).wait_for()
        findings["restores_chat_on_reload"] = page.locator("#task-detail").is_visible()
        choose("Exploratory chat")
        page.locator("#run-note").fill("line one")
        page.locator("#run-note").press("Shift+Enter")
        page.locator("#run-note").type("line two")
        findings["shift_enter_does_not_send"] = not api("/tasks/"+chat["id"])["runs"]
        page.locator("#run-note").press("Enter")
        expect(page.locator("#run-history .status")).to_have_text("Completed", timeout=15000)
        for i, agent in enumerate(["codex", "claude", "codex", "claude", "codex"]):
            page.locator("#run-agent").select_option(agent)
            page.locator("#run-note").fill("Turn " + str(i) + ": remember BLUE-ORBIT.")
            page.locator("#run-note").press("Enter")
            expect(page.locator("#run-history .run")).to_have_count(i+2, timeout=15000)
            expect(page.locator("#run-history .status").last).to_have_text("Completed", timeout=15000)
        data = api("/tasks/"+chat["id"])
        findings["six_alternating_replies_complete"] = len(data["runs"]) == 6 and all(r["state"] == "completed" for r in data["runs"])
        findings["both_providers_have_usage"] = all(x["reported"] for x in data["usage"])
        findings["has_compaction_control"] = page.get_by_role("button", name="Compact", exact=False).count() > 0
        held = []
        pattern = "**/api/tasks/" + chat["id"] + "/runs"
        page.route(pattern, lambda request: held.append(request))
        page.locator("#run-note").fill("A reply whose submission is delayed.")
        page.locator("#run-note").press("Enter")
        page.wait_for_timeout(150)
        assert held
        choose("Existing task")
        page.locator("#run-note").fill("Do not erase this other chat's draft.")
        held[0].continue_()
        page.unroute(pattern)
        page.wait_for_timeout(300)
        expect(page.locator("#run-note")).to_have_value("Do not erase this other chat's draft.")
        choose("Exploratory chat")
        expect(page.locator("#run-history .run")).to_have_count(7,timeout=15000)
        expect(page.locator("#run-history .status").last).to_have_text("Completed",timeout=15000)
        findings["delayed_send_preserves_other_chat_draft"] = True
        data = api("/tasks/"+chat["id"])
        codex_before = next(u["total"] for u in data["usage"] if u["agent"] == "codex")
        before_compact = len(data["runs"])
        page.locator("#run-note").fill("/compact")
        page.locator("#run-note").press("Enter")
        expect(page.locator("#compact-dialog")).to_be_visible()
        page.locator("#compact-summary").fill("We chose BLUE-ORBIT. Keep answers short.")
        page.locator("#confirm-compact").click()
        expect(page.locator("#compact-dialog")).to_be_hidden()
        expect(page.locator("#checkpoint-note")).to_be_visible()
        assert len(api("/tasks/"+chat["id"])["runs"]) == before_compact
        for agent in ["claude", "codex"]:
            preview = api("/tasks/"+chat["id"]+"/preview", {"agent":agent,"note":"Continue from the summary."})
            assert preview["session_id"] is None
            assert "We chose BLUE-ORBIT." in preview["prompt"]
            assert "Turn 0:" not in preview["prompt"]
        findings["compaction_resets_both_sessions_without_a_run"] = True
        findings["summary_replaces_old_prompt_history"] = True
        page.locator("#run-agent").select_option("codex")
        page.locator("#run-note").fill("Continue from the compacted summary.")
        page.locator("#run-note").press("Enter")
        expect(page.locator("#run-history .run")).to_have_count(before_compact+1,timeout=15000)
        expect(page.locator("#run-history .status").last).to_have_text("Completed",timeout=15000)
        after = api("/tasks/"+chat["id"])
        assert next(u["total"] for u in after["usage"] if u["agent"] == "codex") == codex_before + 120
        findings["reply_after_compaction"] = True
        assert all(findings[k] for k in ["preserves_selected_model","preserves_unsent_message","restores_chat_on_reload","six_alternating_replies_complete","both_providers_have_usage","has_compaction_control"])
        page.set_viewport_size({"width":390,"height":844})
        findings["mobile_no_overflow"] = page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        findings["runtime_errors"] = errors
        (ROOT/"scratch").mkdir(exist_ok=True)
        (ROOT/"scratch/ui-exploration.json").write_text(json.dumps(findings,indent=2))
        page.screenshot(path=str(ROOT/"scratch/ui-exploration.png"),full_page=True)
        print(json.dumps(findings,indent=2))
        browser.close()
finally:
    server.stdin.close()
    try:
        server.wait(timeout=15)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
        raise
    if server.returncode:
        raise RuntimeError(server.stderr.read())
