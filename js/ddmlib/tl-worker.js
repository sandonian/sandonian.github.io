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

importScripts("property_formatter.js");
importScripts("../../third_party/protobuf.min.js")
importScripts("../utils.js")
importScripts("../constants.js")

self.onmessage = function(event) {
    const base64String = event.data.bugReportLine.replace(VIEW_CAPTURE_REGEX, "")

    protobuf.load("../../protos/view_capture.proto").then(function(root) {
        postMessage({
            rootNodes: root.lookupType("com.android.launcher3.view.ExportedData")
                           .decode(base64ToUint8Array(base64String))
                           .frameData
                           .map(f => formatProperties(f.node))
        });
        close();
    })
}
