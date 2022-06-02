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

/* Action to refresh activity list */
let activityListAction = function (initializer) {
    progress.show();
    let content = $("#device-list-content").empty();

    let jdwpErrorContainer;
    let windowLoaded;
    let mainContent = $("<div>").appendTo(content);

    let newApiChk = null;

    let startHView = function () {
        let info = $(this).data("appInfo");
        if (newApiChk != null && newApiChk.is(':checked')) {
            info.use_new_api = false;
        }
        info.goBack = function() {
            activityListAction(initializer);
        };

        hViewAction(info);
    }

    let renderActivities = function(container, list) {

        let buttonbar = $("<div class='button-bar'>").css({display: "flex"}).appendTo(container);
        if (list.use_new_api) {
            newApiChk = $('<input type="checkbox" />');
            $("<label class='old-api'>").appendTo(buttonbar).append(newApiChk).append($("<span class='slider'>")).append($("<span class='text'>").text("Load custom properties"));
        } else {
            newApiChk = null;
        }
        if (adbDevice) {
            $("<div>").css({flexGrow: 1}).appendTo(buttonbar);
            $("<button>").text("Mirror Display").appendTo(buttonbar).click(deviceMirrorAction);
        }

        container = $("<div>").appendTo(container).addClass("activity-list");
        if (list.hasIcons) {
            container.addClass("has-icons")
        }
        for (let i = 0; i < list.length; i++) {
            let l = list[i];
            let entry = $("<div>").data("appInfo", l).appendTo(container).click(startHView).addClass("entry");

            if (list.hasIcons) {
                let icon = $('<div class="icon">').appendTo(entry).attr("icon-pid", l.pid);
                if (l.icon && l.icon.value) {
                    icon.css("background-image", `url(${l.icon.value})`);
                }
            }

            if (l.name == "") {
                l.name = "---";
            }
            $('<div class="title">').text(l.name).appendTo(entry);
            let subText;
            if (l.pid != undefined && l.pname != undefined) {
                subText = `${l.pname} (${l.pid})`;
            } else if (l.pname != undefined) {
                subText = l.pname;
            } else if (l.pid != undefined) {
                subText = `Process id: ${l.pid}`;
            } else {
                subText = null;
            }
            if (subText != null) {
                $('<div class="subtext">').appendTo(entry).text(subText);
            }
        }
    }

    let callbacks = {
        jdwpError: function () {
            if (!jdwpErrorContainer) {
                jdwpErrorContainer = $("<div>").prependTo(content)
                    .showError("Using old API. Something bad might have heppend. You should probably take a break.");
            }
        },

        windowsError: function (msg) {
            if (!windowLoaded) {
                progress.hide();
                mainContent.showError(msg);
            }
        },

        windowsLoaded: function (list) {
            windowLoaded = true;
            progress.hide();
            renderActivities(mainContent.empty(), list);
        },

        iconLoaded: function(pid, value) {
            $(`div[icon-pid=${pid}]`).css("background-image", `url(${value})`);
        }
    };

    initializer(callbacks);
};
