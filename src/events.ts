// Copyright 2020 Google LLC
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

import * as express from 'express';
import {
    BackgroundEvent,
    CloudFunctionsContext,
    CloudFunctionsResource,
    CloudEventsContext,
  } from './functions';
import {isBinaryCloudEvent, isCloudEvent, getBinaryCloudEventContext} from './cloudevents';

/**
 * Mapping between background event types and CloudEvent types.
 */
let typeBackgroundToCloudEvent: Record<string, string> = {
    "google.pubsub.topic.publish":                              "google.cloud.pubsub.topic.v1.messagePublished",
    "providers/cloud.pubsub/eventTypes/topic.publish":          "google.cloud.pubsub.topic.v1.messagePublished",
    "google.storage.object.finalize":                           "google.cloud.storage.object.v1.finalized",
    "google.storage.object.delete":                             "google.cloud.storage.object.v1.deleted",
    "google.storage.object.archive":                            "google.cloud.storage.object.v1.archived",
    "google.storage.object.metadataUpdate":                     "google.cloud.storage.object.v1.metadataUpdated",
    "providers/cloud.firestore/eventTypes/document.write":      "google.cloud.firestore.document.v1.written",
    "providers/cloud.firestore/eventTypes/document.create":     "google.cloud.firestore.document.v1.created",
    "providers/cloud.firestore/eventTypes/document.update":     "google.cloud.firestore.document.v1.updated",
    "providers/cloud.firestore/eventTypes/document.delete":     "google.cloud.firestore.document.v1.deleted",
    "providers/firebase.auth/eventTypes/user.create":           "google.firebase.auth.user.v1.created",
    "providers/firebase.auth/eventTypes/user.delete":           "google.firebase.auth.user.v1.deleted",
    "providers/google.firebase.analytics/eventTypes/event.log": "google.firebase.analytics.log.v1.written",
    "providers/google.firebase.database/eventTypes/ref.create": "google.firebase.database.document.v1.created",
    "providers/google.firebase.database/eventTypes/ref.write":  "google.firebase.database.document.v1.written",
    "providers/google.firebase.database/eventTypes/ref.update": "google.firebase.database.document.v1.updated",
    "providers/google.firebase.database/eventTypes/ref.delete": "google.firebase.database.document.v1.deleted",
    "providers/cloud.storage/eventTypes/object.change":         "google.cloud.storage.object.v1.finalized",
};

/**
 * Mapping between background event services and CloudEvent services.
 */
let serviceBackgroundToCloudEvent: Record<string, string> = {
    "providers/cloud.firestore/":           "firestore.googleapis.com",
    "providers/google.firebase.analytics/": "firebase.googleapis.com",
    "providers/firebase.auth/":             "firebase.googleapis.com",
    "providers/google.firebase.database/":  "firebase.googleapis.com",
    "providers/cloud.pubsub/":              "pubsub.googleapis.com",
    "providers/cloud.storage/":             "storage.googleapis.com",
    "google.pubsub":                        "pubsub.googleapis.com",
    "google.storage":                       "storage.googleapis.com",
};

/**
 * Get CloudEvent from the request object.
 * @param req Express request object.
 * @return CloudEvent object or null.
 */
export function getCloudEvent(req: express.Request): CloudEventsContext | null{
    let cloudevent: CloudEventsContext;

    // Handle a CloudEvent in binary mode.
    if (isBinaryCloudEvent(req)) {
        cloudevent = getBinaryCloudEventContext(req);
        cloudevent.data = req.body;
        return cloudevent;
    }

    // Handle a CloudEvent in structured mode.
    if (isCloudEvent(req)) {
        cloudevent = req.body as CloudEventsContext;
        return cloudevent;
    }

    console.log('Converting from background event to CloudEvent');
    let event = getBackgroundEvent(req);
    if (event === null) {
        console.error('Unable to extract background event')
        return null;
    }

    let context = event.context;
    let data = event.data;
    cloudevent = {
        contenttype: "application/json",
        id: context.eventId,
        specversion: "1.0",
        time: context.timestamp,
        data: data
    }

    // Determine CloudEvent type attribute.
    if (typeof context.eventType === 'undefined' ) {
        console.error('Unable to find background event type')
        return null;
    }
    cloudevent.type = typeBackgroundToCloudEvent[context.eventType];

    if (typeof context.resource === 'undefined' ) {
        console.error('Unable to find background event resource')
        return null;
    }
    if (typeof context.resource === 'string' ) {
        // Resource is a raw path.
        // We need to determine the background event service from its type.
        let service = "";
        for (let bService in serviceBackgroundToCloudEvent) {
            let ceService = serviceBackgroundToCloudEvent[bService];
            if (context.eventType.startsWith(bService)) {
                service = ceService;
                break;
            }
        }
        if (service === "") {
            console.error('Unable to find background event service')
            return null;
        }
        cloudevent.source = `//${service}/${context.resource}`;
    } else {
        // Resource is structured data.
        let resource = context.resource;
        cloudevent.source = `//${resource.service}/${resource.name}`;
    }
    
    return cloudevent;
}

/**
 * Get BackgroundEvent object from the request object.
 * @param req Express request object.
 * @return BackgroundEvent object or null.
 */
export function getBackgroundEvent(req: express.Request): BackgroundEvent | null {
    let backgroundEvent: BackgroundEvent;

    if (!isBinaryCloudEvent(req) && !isCloudEvent(req)) {
        let event = req.body;
        let data = event.data;
        let context = event.context;
        if (context === undefined) {
            // Support legacy events in which context properties represented as event top-level properties.
            // Context is everything but data.
            context = event;
            // Clear the property before removing field so the data object
            // is not deleted.
            context.data = undefined;
        }
        backgroundEvent = {
            context: context,
            data: data,
        }
        return backgroundEvent;
    }

    console.log('Converting from CloudEvent to background event');
    let cloudevent = getCloudEvent(req);
    if (cloudevent === null) {
        console.error('Unable to extract CloudEvent')
        return null;
    }

    let context: CloudFunctionsContext;
    context = {
        eventId: cloudevent.id,
        timestamp: cloudevent.time,
    }

    // Determine background event "eventType" attribute.
    if (typeof cloudevent.type === 'undefined' ) {
        console.error('Unable to find CloudEvent type')
        return null;
    }
    for (let bType in typeBackgroundToCloudEvent) {
        let ceType = typeBackgroundToCloudEvent[bType];
        if (ceType === cloudevent.type) {
            context.eventType = bType;
            break;
        }
    }
    if (typeof context.eventType === 'undefined' ) {
        console.error('Unable to find background event type from CloudEvent')
        return null;
    }

    // Determine background event "resource" attribute.
    if (typeof cloudevent.source === 'undefined' ) {
        console.error('Unable to find CloudEvent source')
        return null;
    }
    for (let bService in serviceBackgroundToCloudEvent) {
        let ceService = serviceBackgroundToCloudEvent[bService];
        if (cloudevent.source.includes(ceService)) {
            let type = "";
            if (cloudevent.data["@type"] !== undefined) {
                type = cloudevent.data["@type"];
            } else if (cloudevent.data["kind"] !== undefined) {
                type = cloudevent.data["kind"];
            }

            if (type !== "") {
                // Prefer structured data for resource field.
                context.resource = {
                    type: type,
                    service: ceService,
                    name: cloudevent.source.replace(`//${ceService}/`,''),
                }
            } else {
                // This indicates that resource is a raw path. 
                context.resource = cloudevent.source.replace(`//${ceService}/`,'');
            }
            break;
        }
    }
    if (typeof context.resource === 'undefined' ) {
        console.error('Unable to find background event resource from CloudEvent')
        return null;
    }

    backgroundEvent = {
        context: context,
        data: cloudevent.data,
    }

    return backgroundEvent;
}