#!/usr/bin/env python3
"""QQ bridge task client. Python 3.10+, standard library only; no daemon."""
import argparse
import base64
import contextlib
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

VERSION = "1.1.0"
MIB = 1024 * 1024
HEX = re.compile(r"^[a-f0-9]{64}$")
TIMING_COMMANDS = {"begin", "status", "progress", "final", "resume", "doctor"}
HTTP_OPERATIONS = {"status", "upload_status", "upload", "reply", "health"}
TIMING_ERRORS = {"network_error", "reply_rejected", "client_busy", "reply_needs_review", "task_expired",
                 "task_status_rejected", "insufficient_reply_quota", "operation_content_conflict", "invalid_outbox",
                 "operation_failed_needs_review", "reply_closed_or_failed", "invalid_json_response",
                 "private_artifact_rejected", "invalid_input_or_local_io", "client_error"}
TIMING_LIMIT = 128


class ClientError(Exception):
    def __init__(self, code, **details):
        self.code, self.details = code, details


def require(condition, code):
    if not condition:
        raise ClientError(code)


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def timestamp(value):
    require(isinstance(value, str), "invalid_timing_record")
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.tzinfo is not None, "invalid_timing_record")
    return parsed.astimezone(dt.timezone.utc).isoformat()


def duration(value):
    require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= 1e10, "invalid_timing_record")
    return value


def timing_rows(rows):
    require(isinstance(rows, list) and len(rows) <= 32, "invalid_timing_record")
    clean = []
    for row in rows:
        require(isinstance(row, dict) and row.get("operation") in HTTP_OPERATIONS, "invalid_timing_record")
        code = row.get("http_status")
        require(code is None or (type(code) is int and 100 <= code <= 599), "invalid_timing_record")
        item = {"operation": row["operation"], "http_status": code, "duration_ms": duration(row.get("duration_ms"))}
        if "started_at" in row:
            item["started_at"] = timestamp(row["started_at"])
        clean.append(item)
    return clean


def read_json(file, limit=8 * MIB):
    with open(file, "rb") as source:
        data = source.read(limit + 1)
    require(len(data) <= limit, "json_too_large")
    value = json.loads(data.decode("utf-8-sig"))
    require(isinstance(value, dict), "expected_json_object")
    return value


def is_link(file):
    try:
        info = Path(file).lstat()
        # Windows junctions are reparse points even when Path.is_symlink() is false.
        return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)
    except FileNotFoundError:
        return False


def private_dir(directory):
    require(not is_link(directory), "linked_state_directory")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    require(directory.is_dir(), "invalid_state_directory")
    if os.name != "nt":
        require(stat.S_IMODE(directory.stat().st_mode) & 0o077 == 0, "state_directory_not_private")


def atomic_json(file, value):
    require(not is_link(file), "linked_state_file")
    fd, temporary = tempfile.mkstemp(prefix=".pending-", dir=file.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(encode(value))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, file)
        if os.name != "nt":
            directory = os.open(file.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextlib.contextmanager
def job_lock(directory):
    private_dir(directory)
    lock = directory / "lock"
    require(not is_link(lock), "linked_state_file")
    fd = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(fd, "r+b") as handle:
        require(stat.S_ISREG(os.fstat(handle.fileno()).st_mode), "invalid_lock")
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise ClientError("client_busy") from None
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


class Telemetry:
    """Best-effort private records, independent of the immutable delivery outbox."""
    def __init__(self, root, directory, binding, command, started_at):
        self.file, self.saved = None, False
        self.record = {"schema": 1, "binding": binding, "client_version": VERSION, "command": command,
                       "started_at": started_at, "state": "running", "timings": []}
        try:
            private_dir(root)
            private_dir(directory)
            target = directory / "telemetry"
            private_dir(target)
            with job_lock(target):
                require(sum(1 for p in target.iterdir() if re.fullmatch(r"[a-f0-9]{32}\.json", p.name)) < TIMING_LIMIT,
                        "timing_capacity")
                self.file = target / (uuid.uuid4().hex + ".json")
                self.update()
                if not self.saved:
                    self.file = None
        except Exception:
            self.file = None
            self.saved = False

    def update(self, **fields):
        self.record.update(fields)
        if self.file is None:
            return
        try:
            private_dir(self.file.parent)
            require(len(encode(self.record)) <= 65536, "timing_record_too_large")
            atomic_json(self.file, self.record)
            self.saved = True
        except Exception:
            self.saved = False

    def finish(self, result):
        safe = Client.summary(result.get("result", result))
        if result.get("local_replayed") is True:
            safe["local_replayed"] = True
        error = result.get("error")
        self.update(state="completed", completed_at=result["completed_at"], duration_ms=result["duration_ms"],
                    timings=timing_rows(result["timings"]), active_request=None,
                    result={**safe, "ok": result.get("ok") is True},
                    error_code=error if error in TIMING_ERRORS else "other_client_error" if error else None)


def recorded_timings(root, directory, binding, limit):
    target, entries, invalid = directory / "telemetry", [], 0
    if target.exists() or is_link(target):
        for folder in (root, directory, target):
            require(folder.is_dir() and not is_link(folder), "invalid_timing_directory")
            if os.name != "nt":
                require(stat.S_IMODE(folder.stat().st_mode) & 0o077 == 0, "invalid_timing_directory")
        files = sorted(p for p in target.iterdir() if re.fullmatch(r"[a-f0-9]{32}\.json", p.name))
        require(len(files) <= TIMING_LIMIT, "timing_capacity")
        for file in files:
            try:
                require(not is_link(file) and file.is_file(), "invalid_timing_record")
                item = read_json(file, 65536)
                require(item.get("schema") == 1 and item.get("binding") == binding and item.get("command") in TIMING_COMMANDS
                        and item.get("state") in ("running", "completed"), "invalid_timing_record")
                version = item.get("client_version")
                require(isinstance(version, str) and bool(re.fullmatch(r"\d+\.\d+\.\d+", version)), "invalid_timing_record")
                safe = {"client_version": version, "command": item["command"], "state": item["state"],
                        "started_at": timestamp(item.get("started_at")), "timings": timing_rows(item.get("timings"))}
                if item["state"] == "completed":
                    require(isinstance(item.get("result"), dict), "invalid_timing_record")
                    safe.update(completed_at=timestamp(item.get("completed_at")), duration_ms=duration(item.get("duration_ms")),
                                result=Client.summary(item.get("result", {})))
                    if item["result"].get("local_replayed") is True:
                        safe["result"]["local_replayed"] = True
                    error = item.get("error_code")
                    if error:
                        safe["error_code"] = error if error in TIMING_ERRORS else "other_client_error"
                if item.get("active_request") in HTTP_OPERATIONS:
                    safe.update(active_request=item["active_request"], active_request_started_at=timestamp(item.get("active_request_started_at")))
                entries.append(safe)
            except (ClientError, OSError, ValueError, TypeError, KeyError):
                invalid += 1
    entries.sort(key=lambda item: item["started_at"])
    beginnings = [item for item in entries if item["command"] == "begin"]
    return {"ok": True, "history_read_only": True, "platform_start_known": False, "entries_total": len(entries),
            "invalid_records": invalid, "first_recorded_client_started_at": entries[0]["started_at"] if entries else None,
            "begin_started_at": beginnings[0]["started_at"] if beginnings else None, "entries": entries[-limit:]}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    def __init__(self, args):
        self.args, self.timings, self.telemetry = args, [], None
        self.protected_paths = {Path(args.config).resolve()} if args.config else set()
        config = read_json(args.config, 16384) if args.config else {}
        require(set(config) <= {"reply_url", "reply_token_file"}, "unknown_config_field")
        url = os.environ.get("QQ_REPLY_URL") or config.get("reply_url")
        require(isinstance(url, str) and bool(url), "missing_reply_url")
        parsed = urllib.parse.urlsplit(url)
        require(parsed.scheme == "https" or (parsed.scheme == "http" and parsed.hostname in
                ("127.0.0.1", "localhost", "::1")), "https_required")
        require(bool(parsed.hostname) and parsed.username is None and parsed.password is None and
                "?" not in url and "#" not in url and parsed.path == "/reply", "invalid_reply_url")
        require(parsed.port is None or 0 < parsed.port <= 65535, "invalid_reply_url")
        require(not any(ord(c) < 33 for c in url), "invalid_reply_url")
        self.url, self.origin = url, urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
        token = os.environ.get("QQ_REPLY_TOKEN")
        if config.get("reply_token_file"):
            require(isinstance(config["reply_token_file"], str) and bool(config["reply_token_file"]), "invalid_token_file")
            token_path = Path(config["reply_token_file"])
            if not token_path.is_absolute():
                token_path = Path(args.config).absolute().parent / token_path
            self.protected_paths.add(token_path.resolve())
            if token is None:
                with open(token_path, encoding="utf-8-sig") as source:
                    token = source.read(4097).strip()
        self.token = token
        self.token_available = (isinstance(token, str) and 32 <= len(token) <= 4096 and token.isascii()
                                and all(ord(char) >= 32 and ord(char) != 127 for char in token))
        if args.command != "doctor":
            require(self.token_available, "missing_or_invalid_reply_token")
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, operation, method, path, body=None, headers=None, auth=True, timeout=30):
        request_headers = dict(headers or {})
        if auth:
            request_headers["X-Reply-Token"] = self.token
        request = urllib.request.Request(self.origin + path, data=body, method=method, headers=request_headers)
        status, started_at = None, utc_now()
        if self.telemetry:
            self.telemetry.update(active_request=operation, active_request_started_at=started_at)
        started, started_at = time.perf_counter(), utc_now()
        try:
            try:
                response = self.opener.open(request, timeout=timeout)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                status = response.code
                raw = response.read(MIB + 1)
                require(len(raw) <= MIB, "response_too_large")
            try:
                value = json.loads(raw)
            except (ValueError, UnicodeError):
                raise ClientError("invalid_json_response", http_status=status) from None
            require(isinstance(value, dict), "invalid_json_response")
            return status, value
        except (urllib.error.URLError, TimeoutError, OSError):
            raise ClientError("network_error", action="inspect_task_before_retry") from None
        finally:
            self.timings.append({"operation": operation, "http_status": status, "started_at": started_at,
                                 "duration_ms": round((time.perf_counter() - started) * 1000, 1)})
            if self.telemetry:
                self.telemetry.update(active_request=None, timings=list(self.timings))

    def state_directories(self):
        root = Path(self.args.state_dir) if self.args.state_dir else Path(__file__).absolute().parent / ".state"
        self.state_root = root.resolve()
        return root, root / self.task["job_id"]

    def start_telemetry(self, started_at):
        root, directory = self.state_directories()
        self.telemetry = Telemetry(root, directory, self.binding, self.args.command, started_at)

    def load_task(self):
        require(bool(self.args.task), "task_file_required")
        self.protected_paths.add(Path(self.args.task).resolve())
        task = read_json(self.args.task)
        require(isinstance(task.get("job_id"), str) and bool(HEX.fullmatch(task["job_id"])), "invalid_job_id")
        require(task.get("type") in ("c2c", "group"), "invalid_task_route")
        target = "openid" if task["type"] == "c2c" else "group_openid"
        require(all(isinstance(task.get(key), str) and 0 < len(task[key]) <= 2048
                    for key in (target, "msg_id")), "invalid_task_route")
        self.task = task
        self.route = {key: task[key] for key in ("job_id", "type", target, "msg_id")}
        self.resource = "/jobs/" + task["job_id"]
        self.binding = digest(encode([self.url, self.route]))
        require(isinstance(task.get("reply_policy", {}), dict) and
                isinstance(task.get("reply_policy", {}).get("media", {}), dict), "invalid_reply_policy")

    def deadline(self):
        value = self.task.get("reply_deadline")
        require(isinstance(value, str), "missing_deadline")
        deadline = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(deadline.tzinfo is not None, "invalid_deadline")
        require(deadline.timestamp() > time.time(), "task_expired")

    def status(self):
        status, result = self.request("status", "GET", self.resource)
        if status != 200 or result.get("ok") is not True or result.get("job_id") != self.task["job_id"]:
            raise ClientError("task_status_rejected", http_status=status)
        require(type(result.get("next_reply_seq")) is int and 1 <= result["next_reply_seq"] <= 6 and
                type(result.get("messages_remaining")) is int and 0 <= result["messages_remaining"] <= 5 and
                type(result.get("reply_closed")) is bool and result.get("delivery") in
                ("pending", "dispatching", "accepted", "failed", "expired", "uncertain") and
                result.get("reply") in ("pending", "awaiting_final", "sending", "done", "uncertain"),
                "invalid_task_status")
        return result

    def available(self, status, resume=False):
        self.deadline()
        require(status.get("reply") not in ("sending", "uncertain"), "reply_needs_review")
        if not resume:
            require(status.get("reply_closed") is False and status.get("reply_http_status") in (None, 200),
                    "reply_closed_or_failed")

    def artifacts(self):
        artifacts = []
        for kind, files in (("image", self.args.image), ("file", self.args.file), ("voice", self.args.voice)):
            for file in files:
                path = Path(file)
                resolved = path.resolve()
                require(resolved not in self.protected_paths and not resolved.is_relative_to(self.state_root),
                        "private_artifact_rejected")
                name, size = path.name, path.stat().st_size
                require(path.is_file() and 0 < size <= (100 * MIB if kind == "file" else
                        20 * MIB if kind == "voice" else 5 * MIB), "invalid_artifact_size")
                require(0 < len(name.encode("utf-8")) <= 180 and name.strip() == name and name not in (".", "..")
                        and not re.search(r'[\x00-\x1f\x7f/\\<>:"|?*]', name), "invalid_artifact_name")
                hash_value = hashlib.sha256()
                with path.open("rb") as source:
                    head = source.read(12)
                    hash_value.update(head)
                    while chunk := source.read(MIB):
                        hash_value.update(chunk)
                if kind == "image":
                    require(bool(re.fullmatch(r"[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}\.(png|jpe?g)", name, re.I)), "invalid_image_name")
                    require((name.lower().endswith(".png") and head.startswith(b"\x89PNG\r\n\x1a\n")) or
                            (name.lower().endswith((".jpg", ".jpeg")) and head.startswith(b"\xff\xd8\xff")), "invalid_image_format")
                if kind == "voice":
                    ext = path.suffix.lower()
                    require((ext == ".silk" and (head.startswith(b"#!SILK_V3") or head.startswith(b"\x02#!SILK_V3"))) or
                            (ext == ".wav" and head[:4] == b"RIFF" and head[8:12] == b"WAVE") or
                            (ext == ".mp3" and (head.startswith(b"ID3") or (len(head) >= 2 and head[0] == 255 and head[1] & 0xe0 == 0xe0))) or
                            (ext == ".flac" and head.startswith(b"fLaC")), "invalid_voice_format")
                artifacts.append({"kind": kind, "name": name, "bytes": size, "sha256": hash_value.hexdigest(), "path": path})
        require(len(artifacts) <= 5 and sum(a["bytes"] for a in artifacts if a["kind"] == "image") <= 5 * MIB,
                "attachment_limit")
        return artifacts

    def upload(self, item, directory):
        upload_id = digest(encode([item["kind"], item["name"], item["sha256"]]))
        metadata = {key: item[key] for key in ("kind", "name", "bytes", "sha256")}
        marker, expected = directory / ("upload-" + upload_id + ".json"), {"binding": self.binding, **metadata}
        require(not is_link(marker), "linked_state_file")
        if marker.exists():
            require(read_json(marker, 2048) == expected, "invalid_upload_marker")
            status, result = self.request("upload_status", "GET", self.resource + "/uploads/" + upload_id)
            if status == 200 and result.get("ok") is True:
                media = result.get("media", {})
                require(media.get("upload_id") == upload_id and all(media.get(k) == v for k, v in metadata.items()),
                        "upload_metadata_mismatch")
                return {"upload_id": upload_id}
            require(status == 404, "upload_status_rejected")
        else:
            # Remember the attempt before sending bytes. A later invocation first checks the
            # registry rather than streaming into a server that can answer a replay immediately.
            atomic_json(marker, expected)
        headers = {"Content-Type": "application/octet-stream", "Content-Length": str(item["bytes"]),
                   "X-Media-Kind": item["kind"], "X-Media-Name": urllib.parse.quote(item["name"], safe="~()*!.'-"),
                   "X-Content-SHA256": item["sha256"]}
        self.deadline()
        with item["path"].open("rb") as source:
            require(os.fstat(source.fileno()).st_size == item["bytes"], "artifact_changed")
            status, result = self.request("upload", "PUT", self.resource + "/uploads/" + upload_id,
                                          source, headers, timeout=120)
        require(status == 200 and result.get("ok") is True and result.get("media", {}).get("upload_id") == upload_id,
                "upload_rejected")
        return {"upload_id": upload_id}

    @staticmethod
    def summary(result):
        keys = ("ok", "replayed", "reply_seq", "final", "messages_used", "messages_remaining", "next_reply_seq",
                "parts_sent", "parts_total", "truncated", "images_sent", "images_total", "images_skipped",
                "files_sent", "files_total", "voices_sent", "voices_total")
        return {key: result[key] for key in keys if key in result and type(result[key]) in (bool, int)}

    def send(self, record, journal):
        self.deadline()
        # The durable body is immutable. Never automatically retry a POST after a transport error.
        status, result = self.request("reply", "POST", "/reply", encode(record["body"]),
                                      {"Content-Type": "application/json"})
        safe = self.summary(result)
        safe["http_status"] = status
        success = 200 <= status < 300 and safe.get("ok") is True
        complete = not safe.get("truncated") and not safe.get("images_skipped") and all(
            safe.get(label + "_sent") == safe.get(label + "_total")
            for label in ("parts", "images", "files", "voices") if label + "_total" in safe)
        success = success and complete
        record.update(state="done" if success else "failed", result=safe)
        atomic_json(journal, record)
        if not success:
            raise ClientError("reply_rejected", result=safe, action="inspect_task_before_retry")
        return safe

    def reply(self):
        require(bool(re.fullmatch(r"[A-Za-z0-9_-]{1,64}", self.args.operation)), "invalid_operation")
        state_root, directory = self.state_directories()
        private_dir(state_root)
        with job_lock(directory):
            journal = directory / (self.args.operation + ".json")
            require(not is_link(journal), "linked_state_file")
            record = read_json(journal, 9 * MIB) if journal.exists() else None
            if record:
                require(record.get("schema") == 1 and record.get("binding") == self.binding and
                        record.get("state") in ("pending", "done", "failed") and isinstance(record.get("body"), dict) and
                        record.get("body_hash") == digest(encode(record["body"])) and
                        all(record["body"].get(key) == value for key, value in self.route.items()), "invalid_outbox")
            if self.args.command == "resume":
                require(record is not None, "operation_not_found")
            else:
                if self.args.text_file:
                    with open(self.args.text_file, "rb") as source:
                        data = source.read(65537)
                    require(len(data) <= 65536, "text_too_large")
                    text = data.decode("utf-8-sig")
                else:
                    text = self.args.text or ""
                artifacts = self.artifacts()
                final = self.args.command == "final"
                require(bool(text) or bool(artifacts), "empty_reply")
                units = text.encode("utf-16-le")
                require(len(units) <= 15000, "text_too_large")
                require(final or (len(units) <= 3000 and not artifacts), "invalid_progress")
                intent = digest(encode([final, text, [{k: a[k] for k in ("kind", "name", "bytes", "sha256")} for a in artifacts]]))
                if record:
                    require(record.get("intent") == intent, "operation_content_conflict")
            if record and record["state"] == "done":
                return {**record["result"], "local_replayed": True}
            require(not record or record["state"] != "failed", "operation_failed_needs_review")
            status = self.status()
            self.available(status, resume=record is not None)
            if record:
                return self.send(record, journal)
            policy = self.task.get("reply_policy", {})
            require(policy.get("segmented") is True or (final and status["next_reply_seq"] == 1), "segmentation_unavailable")
            # Use the same UTF-16 and paragraph/line splitting rules as the server.
            parts = text_parts(text)
            require(parts + len(artifacts) + (0 if final else 1) <= status["messages_remaining"], "insufficient_reply_quota")
            body = {**self.route, "content": text}
            if policy.get("segmented") is True:
                body.update(reply_seq=status["next_reply_seq"], final=final)
            media_policy = policy.get("media", {})
            require(len(artifacts) <= min(5, media_policy.get("max_items", 5)), "attachment_limit")
            for item in artifacts:
                require(item["kind"] == "image" or item["kind"] in media_policy.get("kinds", []), "media_unavailable")
            inline = sum(a["bytes"] for a in artifacts) <= min(5 * MIB, media_policy.get("inline_max_bytes", 5 * MIB))
            uploads = [a for a in artifacts if a["kind"] != "image" and not inline]
            require(sum(a["bytes"] for a in uploads) <= min(100 * MIB, media_policy.get("job_upload_max_bytes", 100 * MIB)), "upload_limit")
            for item in artifacts:
                if item["kind"] != "image":
                    maximum = media_policy.get("voice_max_bytes" if item["kind"] == "voice" else "file_max_bytes", 0)
                    require(item["bytes"] <= maximum, "media_size_limit")
                if item in uploads:
                    body.setdefault("media", []).append(self.upload(item, directory))
                else:
                    data = item["path"].read_bytes()
                    require(len(data) == item["bytes"] and digest(data) == item["sha256"], "artifact_changed")
                    entry = {"name": item["name"], "data": base64.b64encode(data).decode("ascii")}
                    if item["kind"] == "image":
                        body.setdefault("images_base64", []).append(entry)
                    else:
                        body.setdefault("media_base64", []).append({"kind": item["kind"], **entry})
            require(len(encode(body)) <= 8 * MIB, "reply_json_too_large")
            record = {"schema": 1, "binding": self.binding, "intent": intent, "body": body,
                      "body_hash": digest(encode(body)), "state": "pending"}
            atomic_json(journal, record)
            return self.send(record, journal)


def text_parts(text):
    # Match the bridge's JS UTF-16 slicing and paragraph/line boundary preference.
    rest, count = text.encode("utf-16-le"), 0
    while len(rest) > 3000:
        units = [rest[i:i + 2] for i in range(0, len(rest), 2)]
        cut = 1500
        for separator in ([b"\n\0", b"\n\0"], [b"\n\0"]):
            indexes = [i for i in range(min(1500, len(units) - len(separator)), -1, -1)
                       if units[i:i + len(separator)] == separator]
            if indexes and indexes[0] + len(separator) <= 1500:
                cut = indexes[0] + len(separator)
                break
        rest, count = rest[cut * 2:], count + 1
    return count + (1 if rest else 0)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--config", help="private JSON with reply_url and reply_token_file; no URL default")
    parser.add_argument("--task", help="original webhook payload JSON; routing is read from this file")
    parser.add_argument("--state-dir", help="private outbox directory; default: .state beside this script")
    commands = parser.add_subparsers(dest="command", required=True)
    doctor = commands.add_parser("doctor", help="read-only client check; --live probes unauthenticated /health")
    doctor.add_argument("--live", action="store_true")
    commands.add_parser("status", help="read current task state")
    commands.add_parser("begin", help="record local client entry only; no HTTP request or QQ message")
    commands.add_parser("timings", help="read recorded client timings offline; never reconstruct old timestamps").add_argument(
        "--limit", type=int, choices=range(1, TIMING_LIMIT + 1), default=20)
    for command in ("progress", "final"):
        sub = commands.add_parser(command)
        sub.add_argument("--operation", default=command, help="stable local operation ID; reuse for retries")
        text = sub.add_mutually_exclusive_group()
        text.add_argument("--text")
        text.add_argument("--text-file")
        for kind in ("image", "file", "voice"):
            sub.add_argument("--" + kind, action="append", default=[], help="local artifact; repeat to attach several")
    commands.add_parser("resume", help="explicitly resubmit the exact saved body after checking task state").add_argument("--operation", required=True)
    args, client = parser.parse_args(), None
    started, started_at = time.perf_counter(), utc_now()
    try:
        require(sys.version_info >= (3, 10), "python_3_10_required")
        client = Client(args)
        if args.command != "doctor" or args.task:
            client.load_task()
            if args.command != "timings":
                client.start_telemetry(started_at)
        if args.command == "doctor":
            result = {"ok": client.token_available, "client_version": VERSION, "python_version": sys.version.split()[0],
                      "reply_url_configured": True, "reply_token_available": client.token_available}
            if args.live:
                status, health = client.request("health", "GET", "/health", auth=False)
                require(status == 200 and health.get("ok") is True, "health_check_failed")
                require(isinstance(health.get("version"), str) and
                        bool(re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", health["version"])) and
                        health.get("ws_state") == "OPEN", "live_bridge_not_ready")
                result.update(bridge_version=health.get("version"), ws_state=health.get("ws_state"))
        else:
            if args.command == "begin":
                result = {"ok": True, "marker": "client_entry", "platform_start_known": False}
            elif args.command == "timings":
                root, directory = client.state_directories()
                result = recorded_timings(root, directory, client.binding, args.limit)
            elif args.command == "status":
                status = client.status()
                result = {key: status.get(key) for key in ("ok", "delivery", "reply", "reply_closed", "next_reply_seq", "messages_remaining")}
            else:
                result = client.reply()
        code = 0 if result.get("ok") else 1
    except ClientError as error:
        result, code = {"ok": False, "error": error.code, **error.details}, 1
    except (OSError, ValueError, TypeError, KeyError, OverflowError):
        result, code = {"ok": False, "error": "invalid_input_or_local_io"}, 1
    except Exception:
        # Never expose raw exceptions, paths, credentials, or proxy response text.
        result, code = {"ok": False, "error": "client_error"}, 1
    result["timings"] = client.timings if client else []
    result["started_at"] = started_at
    result["completed_at"] = utc_now()
    result["duration_ms"] = round((time.perf_counter() - started) * 1000, 1)
    if client and client.telemetry:
        try:
            client.telemetry.finish(result)
        except Exception:
            client.telemetry.saved = False
        result["telemetry_saved"] = client.telemetry.saved
    print(json.dumps(result, ensure_ascii=True))
    return code


if __name__ == "__main__":
    sys.exit(main())
