"""Editor completion: what can follow a dot, with signatures and notes."""

from conftest import use_python


def names(response):
    return [i["name"] for i in response["items"]]


def test_string_methods_after_a_dot(client, project, python):
    use_python(project, python)
    text = "text = ' Python Programming '\nclean = text.strip()\nresult = clean."
    r = client.post("/api/complete", json={"path": "test.py", "text": text, "line": 3, "column": len("result = clean.")}).json()
    assert {"upper", "lower", "split", "replace", "startswith"} <= set(names(r))
    upper = next(i for i in r["items"] if i["name"] == "upper")
    assert upper["type"] == "function"
    d = client.post("/api/complete/detail", json={"path": "test.py", "text": text, "line": 3,
                                                   "column": len("result = clean."), "name": "split"}).json()
    assert d["signature"] and "split(" in d["signature"]
    assert d["doc"]  # the method's documentation (the "notes")


def test_installed_packages_from_the_projects_environment(client, project, python):
    use_python(project, python)  # the test environments have numpy and pandas
    text = "import numpy as np\nnp.ar"
    r = client.post("/api/complete", json={"path": "a.py", "text": text, "line": 2, "column": 5}).json()
    assert {"array", "arange"} <= set(names(r))


def test_the_projects_own_modules(client, project, python):
    use_python(project, python)
    (project / "helpers.py").write_text("def average(values):\n    \"\"\"Mean of a list.\"\"\"\n    return sum(values) / len(values)\n")
    text = "import helpers\nhelpers."
    r = client.post("/api/complete", json={"path": "main.py", "text": text, "line": 2, "column": 8}).json()
    assert "average" in names(r)
    d = client.post("/api/complete/detail", json={"path": "main.py", "text": text, "line": 2, "column": 8, "name": "average"}).json()
    assert "Mean of a list." in d["doc"]


def test_bad_positions_dont_fail(client, project, python):
    use_python(project, python)
    r = client.post("/api/complete", json={"path": "a.py", "text": "x = 1", "line": 9, "column": 99})
    assert r.status_code == 200 and r.json()["items"] == []


def test_completion_needs_the_token(client):
    r = client.post("/api/complete", json={"text": "x.", "line": 1, "column": 2}, headers={"x-tandem-token": "nope"})
    assert r.status_code == 403
