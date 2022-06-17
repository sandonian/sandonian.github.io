// Copyright 2018 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const DISABLE_JDWP = false;

function DDMClient(device, callbacks) {
    device.closeAll();

    this.callbacks = callbacks;
    this.device = device;
    this.processCache = {};
    this.reloadCount = 0;
    this.workingOnWindowList = true;
    this.processNameErrorCount = 0;
    this.processCount = 0;

    this.iconLoader = device.sendFile("/data/local/tmp/processicon.jar", "commands/processicon.jar");
    this.loadProp("density", "ro.sf.lcd_density");
    this.loadProp("sdk_version", "ro.build.version.sdk");
}

DDMClient.prototype.loadProp = async function (property, command) {
    this[property] = -1;
    let msg = await this.device.shellCommand("getprop " + command);
    if (msg != "") {
        this[property] = parseInt(msg);
    }
}

DDMClient.prototype.loadOldWindows = async function () {
    // Stop window service and start it again
    await this.device.shellCommand("service call window 2");
    await this.device.shellCommand("service call window 1 i32 4939");

    let stream = this.device.openStream("tcp:4939");
    stream.onReceiveWrite = function (result) {
        result = ab2str(result);
        stream.sendReady();
        if (result.indexOf("LIST UPDATE") > -1) {
            this._listOldWindows();
            this.reloadWindows();
        }
    }.bind(this);
    stream.write("AUTOLIST\n");
    this._listOldWindows();
}

DDMClient.prototype._listOldWindows = async function () {
    if (!this.workingOnWindowList) return;

    let stream = this.device.openStream("tcp:4939");
    stream.write("LIST\n");

    let list = await stream.readAll();
    list = list.trim().split("\n");

    let result = [];
    for (let i = 0; i < list.length - 1; i++) {
        let parts = list[i].split(" ");
        result.push({
            type: TYPE_OLD,
            name: parts[1].trim(),
            id: parts[0].trim(),
            density: this.density,
            sdk_version: this.sdk_version,
            device: this.device,
            use_new_api : false
        });
    };
    result.use_new_api = false;
    if (this.workingOnWindowList) {
        this.callbacks.windowsLoaded(result);
    }
}

DDMClient.prototype.readProcessList = function (socket) {
    let that = this;
    socket.read(4, function (data) {
        let len = parseInt(ab2str(data), 16);
        socket.read(len, function (data) {
            let list = ab2str(data).trim();
            that.parseProcessList(list.split("\n"));
            that.readProcessList(socket);
        });
    });
}

DDMClient.prototype.trackProcesses = function () {
    if (DISABLE_JDWP) {
        return;
    }
    let stream = this.device.openStream("track-jdwp");
    this.readProcessList(stream);
}

DDMClient.prototype.parseProcessList = function (list) {
    let oldCache = this.processCache;
    let newCache = {};
    this.processCache = newCache;
    this.processCount = list.length;
    for (let i = 0; i < list.length; i++) {
        let pid = list[i];
        if (oldCache[pid]) {
            // process already exists
            newCache[pid] = oldCache[pid];
            oldCache[pid] = null;
        } else {
            // Load process name
            this.loadProcessName(pid);
        }
    }

    for (let pid in oldCache) {
        if (oldCache[pid]) {
            if (oldCache[pid].jdwp) {
                oldCache[pid].jdwp.destroy();
            }
        }
    }
    this.reloadWindows();
}

DDMClient.prototype.loadProcessName = async function (pid) {
    let loader = new jdwp(pid, this.device);
    this.processCache[pid] = { jdwp: loader };

    try {
        let data = await loader.writeChunk("HELO", [0, 0, 0, 1]);
        data.readInt(); // server version
        data.readInt(); // process id

        let vmlen = data.readInt();
        let len = data.readInt();
        data.readStr(vmlen);    // VM description len

        let name = data.readStr(len);

        if (this.processCache[pid]) {
            this.processCache[pid].name = name;
        }
    } catch (e) {
        // Unable to load process name
        this.processNameErrorCount++;
        if (this.processNameErrorCount >= this.processCount) {
            this.callbacks.jdwpError();
        }
    }
}

DDMClient.prototype.reloadWindows = async function () {
    this.reloadCount++;
    let myCount = this.reloadCount;

    let windowToIdMap = {};

    for (let pid in this.processCache) {
        this._loadWindowsForPid(pid, myCount, windowToIdMap).catch(e => {});
    }
}

DDMClient.prototype._newWindowLoaded = function (myCount, windowToIdMap) {
    if (myCount != this.reloadCount) {
        // This is called from some old call
        return;
    }
    let windowList = [];
    for (let pid in windowToIdMap) {
        windowList = windowList.concat(windowToIdMap[pid]);
    }
    if (windowList.length == 0) return;
    if (this.workingOnWindowList) {
        this.workingOnWindowList = false;
    }
    windowList.sort(function (a, b) {
        if (a.name > b.name) return 1;
        if (a.name < b.name) return -1;
        return 0;
    });

    windowList.use_new_api = this.sdk_version >= 23;
    windowList.hasIcons = true;
    this.callbacks.windowsLoaded(windowList);
}

DDMClient.prototype._loadWindowsForPid = async function (pid, myCount, windowToIdMap) {
    let jdwp = this.processCache[pid].jdwp;
    let data = await jdwp.writeChunk("VULW", [0, 0, 0, 1]);
    if (myCount != this.reloadCount) {
        return;
    }
    let count = data.readInt();
    let windowList = [];

    for (let i = 0; i < count; i++) {
        let id = data.readStr();
        let name = id;

        if (this.processCache[pid].icon == undefined) {
            let iconGetter = this._getIconForPid(pid);
            let that = this;
            iconGetter.then(v =>  {
                iconGetter.value = v
                that.callbacks.iconLoaded(pid, v);
            });
            this.processCache[pid].icon = iconGetter;
        }

        if (count == 1) {
            name = name.split("/")[0];
        } else {
            name = name.substr(0, name.lastIndexOf("/"));
        }
        windowList.push({
            type: TYPE_JDWP,
            pid: pid,
            device: this.device,
            id: id,
            density: this.density,
            sdk_version: this.sdk_version,
            name: name,
            use_new_api: this.sdk_version >= 23,
            pname: this.processCache[pid].name,
            icon: this.processCache[pid].icon
        });
    }

    windowToIdMap[pid] = windowList;
    this._newWindowLoaded(myCount, windowToIdMap);
}

DDMClient.prototype._getIconForPid = async function (pid) {
    await this.iconLoader;
    let response = (await this.device.shellCommand(
        "export CLASSPATH=/data/local/tmp/processicon.jar;exec app_process /system/bin ProcessIcon " + pid)).split("\n", 2);
    if ("OKAY" != response[0]) {
        throw "Unable to fetch icon";
    }
    let r = createBlobFromDataUrl(response[1], "image/png");

    // console.log("Loading icon for " + pid);

    return r;
}

function resetActiveState() {
    for (let i = 0; i < ActiveState.length; i++) {
        ActiveState[i]();
    }
    ActiveState = [];
    if (adbDevice) {
        ActiveState.push(function () {
            adbDevice.closeAll();
        });
    }
}

function createViewController(appInfo) {
    resetActiveState();

    if (appInfo.type == TYPE_ZIP) {
        return new OfflineServiceController(appInfo)
    } else if (appInfo.type == TYPE_OLD) {
        return new ViewServiceController(appInfo);
    } else if (appInfo.type == TYPE_BUG_REPORT) {
        return new BugReportServiceControllerLegacy(appInfo);
    } else if (appInfo.type == TYPE_BUG_REPORT_V2) {
        return new BugReportServiceController(appInfo);
    } else {
        return new JdwpController(appInfo);
    }
}

function parseViewData(data, cmd, callback) {
    let w = new Worker("js/ddmlib/worker.js");
    w.onerror = function () {
        callback.reject("Error parsing view data");
    }
    w.onmessage = function (e) {
        let root = e.data.root;
        let setParent = function (node) {
            for (let i = 0; i < node.children.length; i++) {
                node.children[i].parent = node;
                setParent(node.children[i]);
            }

            // Update named properties.
            node.namedProperties = {};
            for (let i = 0; i < node.properties.length; i++) {
                node.namedProperties[node.properties[i].fullname] = node.properties[i];
            }
        }
        setParent(root);
        callback.accept(root);
    }
    w.postMessage({ cmd: cmd, data: data });
}

/**
 * Controller based on offline data
 */
class OfflineServiceController {
    constructor(appInfo) {
        this.zip = appInfo.data;
        this.density = appInfo.config.density ? appInfo.config.density : -1;
        this.sdk_version = appInfo.config.sdk_version ? appInfo.config.sdk_version : -1;
        this.use_new_api = appInfo.config.use_new_api;
    }
    loadViewList() {
        let result = deferred();
        let text = this.zip.file("hierarchy.txt").asText();
        if (!text) {
            result.reject("Unable to load data");
        }
        else {
            let cmd = CMD_PARSE_OLD_DATA;
            if (!this.use_new_api) {
                cmd = cmd | CMD_USE_PROPERTY_MAP;
            }
            parseViewData(text, cmd, result);
        }
        return result;
    }
    async captureView(viewName) {
        let file = this.zip.file("img/" + viewName + ".png");
        if (!file) {
            throw "Image not found";
        }
        return file.asUint8Array();
    }
}


class BugReportServiceController {
    constructor(appInfo) {
        this.data = appInfo.data;
        this.use_new_api = true;
        let display = appInfo.display;
        this.display = null;
        if (display.width != undefined && display.width > 0 && display.height != undefined && display.height > 0) {
            this.display = display;
            if (display.density > 0) {
                this.density = display.density;
            }
        }
    }

    loadViewList_(result) {
        parseViewData(this.data, 0, result);
    }
    loadViewList() {
        let result = deferred();
        this.loadViewList_(result);

        if (this.display != null) {
            let that = this;
            result.then(node => {
                if (node.windowX != undefined && node.windowY != undefined) {
                    let crop = [node.windowX, node.windowY, node.width, node.height];
                    that.loadScreenshot = function () {
                        return pickPngAndCrop(that.display, crop);
                    };
                }
            });
        }
        return result;
    }

    async captureView(viewName) {
        throw "Image not found";
    }
}

class BugReportServiceControllerLegacy extends BugReportServiceController {
    constructor(appInfo) {
        super(appInfo);
    }

    loadViewList_(result) {
        let binary_string = atob(this.data);
        let len = binary_string.length;
        let bytes = new Uint8Array( len );
        for (let i = 0; i < len; i++)        {
            let ascii = binary_string.charCodeAt(i);
            bytes[i] = ascii;
        }
        parseViewData(bytes, CMD_DEFLATE_STRING, result);
    }
}

function pickPngAndCrop(display, crop) {
    let result = deferred();
    let el = $("<input type='file' accept='.png' />");
    el.on("change", function () {
		if (!this.files || this.files.length < 1) {
			return;
		}
        let file = this.files[0];
		let reader = new FileReader();
		reader.onload = function () {
            let img = createImageBitmap(new Blob([new Uint8Array(reader.result)]));
            img.then(d => {
                let canvas = document.createElement('canvas');
                canvas.width = crop[2]; canvas.height = crop[3];
                let ctx = canvas.getContext('2d');
                let sx = d.width / display.width;
                let sy = d.height / display.height;
                ctx.drawImage(d, crop[0] * sx, crop[1] * sy, crop[2] * sx, crop[3] * sy, 0, 0, crop[2], crop[3]);

                let dataurl = canvas.toDataURL();
                let arr = dataurl.split(','), mime = arr[0].match(/:(.*?);/)[1];
                result.accept(createBlobFromDataUrl(arr[1], mime));
            });
		}
		reader.readAsArrayBuffer(file);
    });
    el.click();
    return result;
}

function createBlobFromDataUrl(dataUrl, mime) {
    let bstr = atob(dataUrl);
    let n = bstr.length;
    let u8arr = new Uint8Array(n);
    while(n--){
        u8arr[n] = bstr.charCodeAt(n);
    }
    return createUrl(new Blob([u8arr], {type:mime}));
}

function searializeNode(root) {
    let result = "";

    let printNode = function (node, shift) {
        let line = shift + node.name + " ";
        for (let i = 0; i < node.properties.length; i++) {
            let p = node.properties[i];
            let value = p.value + "";
            if (value == "") value = "null";
            value = value.replace(/(\r|\n)/g, ' ');

            line += p.fullname + "=" + value.length + "," + value + " ";
        }
        result += line + "\n";
        for (let i = 0; i < node.children.length; i++) {
            printNode(node.children[i], shift + " ");
        }
    }
    printNode(root, "");
    result += "DONE.\n";
    return result;
}

/**
 * Controller based on view service
 */
class ViewServiceController {
    constructor(appInfo) {
        this.id = appInfo.id;
        this.port = appInfo.port;
        this.density = appInfo.density;
        this.sdk_version = appInfo.sdk_version;
        this.use_new_api = false;
        this.device = appInfo.device;
    }
    async loadViewList() {
        let stream = this.device.openStream("tcp:4939");
        stream.write("DUMP " + this.id + "\n");
        let text = await stream.readAll();
        let result = deferred();
        parseViewData(text, CMD_PARSE_OLD_DATA | CMD_USE_PROPERTY_MAP, result);
        return await result;
    }
    captureView(viewName) {
        let stream = this.device.openStream("tcp:4939");
        stream.write("CAPTURE " + this.id + " " + viewName + "\n");
        return stream.readAll(new ByteResponseMerger());
    }
    profileView(viewName) {
        let stream = this.device.openStream("tcp:4939");
        stream.write("PROFILE " + this.id + " " + viewName + "\n");
        return stream.readAll();
    }
}

/**
 * Controller based on jdwp protocol
 */
class JdwpController {
    constructor(appInfo) {
        this.windowId = appInfo.id;
        this.pid = appInfo.pid;
        this.device = appInfo.device;
        this.density = appInfo.density;
        this.sdk_version = appInfo.sdk_version;
        this.jdwp = new jdwp(this.pid, this.device);
        this.use_new_api = appInfo.use_new_api;
    }
    async loadViewList() {
        let req = new DataOutputStream();
        req.writeInt(1); // VURT_DUMP_HIERARCHY
        req.writeStr(this.windowId); // root view
        req.writeInt(0); // Do not skip children
        req.writeInt(1); // Include properties
        let cmd = CMD_CONVERT_TO_STRING | CMD_PARSE_OLD_DATA | CMD_USE_PROPERTY_MAP;
        if (this.use_new_api) {
            req.writeInt(1); // Use v2
            cmd = CMD_SKIP_8_BITS;
        }
        let reader = await this.jdwp.writeChunk("VURT", req);
        throwIfFail(reader);
        let result = deferred();
        parseViewData(reader.data, cmd, result);
        return await result;
    }
    async captureView(viewName) {
        let req = new DataOutputStream();
        req.writeInt(1); // VUOP_CAPTURE_VIEW
        req.writeStr(this.windowId); // root view
        req.writeStr(viewName); // target view
        let reader = await this.jdwp.writeChunk("VUOP", req);
        throwIfFail(reader);
        return new Uint8Array(reader.data.buffer, 8);
    }
    async profileView(viewName) {
        let req = new DataOutputStream();
        req.writeInt(3); // VUOP_PROFILE_VIEW
        req.writeStr(this.windowId); // root view
        req.writeStr(viewName); // target view
        let reader = await this.jdwp.writeChunk("VUOP", req);
        throwIfFail(reader);
        return new TextDecoder().decode(new Uint8Array(reader.data.buffer, 8));
    }
    async customCommand(viewName, commandData) {
        let req = new DataOutputStream();
        req.writeInt(4); // VUOP_INVOKE_VIEW_METHOD
        req.writeStr(this.windowId); // root view
        req.writeStr(viewName); // target view
        req.writeBytes(commandData);
        let reader = await this.jdwp.writeChunk("VUOP", req);
        throwIfFail(reader);
    }
}

function throwIfFail(reader) {
    if (reader.chunkType == getChunkType("FAIL")) {
        reader.readInt();   // Error code
        throw reader.readStr();
    }
}