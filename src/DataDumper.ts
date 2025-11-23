import { Plugin, SettingsTypes, ActionState, EntityType } from "@ryelite/core"
import { PanelManager } from "@ryelite/core"


/*
    skilling data collector and dumper for highspell.
    keep track of how many items you receive while skilling and how long it takes to get each one.
    can be used to figure out the impact of skill levels and equipment on item gain, demystify 'probability' rates in game code, and find undocumented rates for rare items.
    this plugin just collects and exports data: you gotta do the analysis yourself, elsewhere.

    goalz:
        - generally find out how many items you can expect to receive per hour of skilling with a given loadout
        - explain the 'probability' value defined in game code (forestry, fishing, crime)
            - we already kinda know crime but i want to also confirm it with actual game data
        - define invisible equipment bonuses (hatchets, pickaxes)
        - define skill level impact
        - find rates for rare items (lucky logs, gems, messages in bottles, fuchsia/cela keys)
*/


/* datapoint that's open and being written to */
interface OpenDatapoint {
    startTime: number  // unix time we started (ms)
    skillID: number  // what skill is being trained
    skillLevel: number  // level of that skill, including all boosts
    loadout: number[]  // equipped item IDs
    target: Target
    itemsReceived: OpenItem[]  // array of every item in the order they were received
}

/* datapoint after it's closed and saved to storage */
interface StoredDatapoint {
    skillName: string
    skillLevel: number
    loadout: string[]  // equipped item names
    target: Target
    itemsReceived: StoredItemDict
}

/* single collected item, in an open datapoint */
interface OpenItem {
    itemId: number,
    quantity: number,
    isIOU: Boolean,
    timestamp: number,  // unix timestamp (ms) when we collected this fella
}

/* single stored item, in a closed datapoint */
interface StoredItem {
    time: number,  // time it took to collect this individual item
    quantity: number,
    isIOU: Boolean,
}

/* dict of stored item data in a closed datapoint */
interface StoredItemDict {
    [itemName: string]: Array<StoredItem>
}


/* all possible target types */
type targetType = "Environment" | "NPC" | "Player"  // notably, cannot target items

/* entity we clicked to begin skilling (e.g. oak tree) */
interface Target {
    id: number,  // generic id, as found in the carbon files
    name: string,  // human readable name
}


/* the last item we received in our inventory */
interface LastItemReceived {
    menuType: number  // can be a bunch of things. we only care about 0 = our inventory
    itemID: number
    quantity: number
    isIOU: Boolean
    timestamp: number  // unix timestamp (ms) when we received this item
}


/* simplified MainPlayer obj */
class SimplePlayer {
    player: any

    constructor(player: any) {
        this.player = player
    }

    /* player's current entity ID */
    get id(): number {
        return this.player._entityId
    }

    /* array of player's equipped item IDs */
    get loadout(): number[] {
        const loadoutDefs = this.player._loadout._items
        let loadoutIDs: number[] = []
        loadoutDefs.forEach(
            (item) => {
                // nothing in this slot
                if (!item) {
                    return
                }
                loadoutIDs.push(item._id)  // just the IDs please
            }
        )
        return loadoutIDs
    }

    /* map of player skill levels (skillID => level). includes visible and invisible boosts */
    get skills(): Map<number, number> {
        // mash all skills together
        const skillDefs: any[] = [].concat(
            this.player._hitpoints,
            this.player._combat._skills,
            this.player._skills._skills,
        )
        // get base skill levels
        let skillLevels: Map<number, number> = new Map()
        skillDefs.forEach(
            (skill) => {
                const id = skill._skill
                const level = skill._currentLevel  // _currentLevel is the top level number that includes potion boosts ("visible" boosts)
                skillLevels.set(id, level)
            }
        )
        // add any equipment bonuses ("invisible" boosts)
        this.player._loadout._items.forEach(
            (item) => {
                // nothing in this slot
                if (!item) {
                    return
                }
                const equippableEffects: any[] = item._def._equippableEffects
                // no skill effects from this equipment
                if (!equippableEffects) {
                    return
                }
                // parse each effect and add to our total
                equippableEffects.forEach(
                    (effect) => {
                        const skillID = effect._skill
                        const equipBonus = effect._amount
                        const currentLevel = skillLevels.get(skillID)
                        const boostedLevel = currentLevel + equipBonus
                        skillLevels.set(skillID, boostedLevel)
                    }
                )
            }
        )
        return skillLevels
    }
}


export default class DataDumpy extends Plugin {
    panelManager: PanelManager = new PanelManager()
    pluginName: string = "DataDumper"
    author: string = "wienerWizard"
    version: string = "0.3.0"

    enableDebug: Boolean = true  // display debug messages in console
    player: SimplePlayer | null = null  // ez player reference with the data that we want in the format that we want it
    datapoint: OpenDatapoint | null = null  // our active skilling data being logged right now
    lastItem: LastItemReceived | null = null  // last item we heard come in, for verification checks
    lastTarget: Target | null = null  // last target we set our beady eyes on, to know what exactly we're skilling on (tree, rock, etc)

    constructor() {
        super()

        // export all data to a txt file and save
        this.settings.ExportDataButton = {
            text: "Export data to file",
            type: SettingsTypes.button,
            value: "",
            callback: () => this.exportStoredData(),
        }
        // exports data with json.stringify pretty print
        this.settings.PrettyPrintExportCheckbox = {
            text: "pretty print",
            type: SettingsTypes.checkbox,
            value: false,
            callback: () => {}  // noop
        }

        // wipe internal data
        this.settings.WipeStoredData = {
            text: "👿 CLEAR DATA 👿",
            type: SettingsTypes.button,
            value: "",
            callback: () => this.clearStoredData()
        }
    }


    /* base plugin functions */
    init(): void {
        this.log(`initialised v${this.version} :D`)
        this.debug("\n\n\njust letting you know that debug is active ok thanks\n\n\n")
    }
    start(): void {
        this.log("starting :)")
        // init internal storage on first run
        if (!this.data.datapoints) {
            this.data.datapoints = []
        }
        // load real MainPlayer once we're logged in
        this.player = new SimplePlayer(this.gameHooks.EntityManager.Instance.MainPlayer)
        // wipe any old data still floating around
        this.datapoint = null
        this.lastItem = null
        this.lastTarget = null
        this.updateExportButton()
    }
    stop(): void {
        this.saveAndCloseDatapoint()  // exit gracefully if user logs out while skilling
        this.log("stopping :(")
    }

    /* lower level of logging, to not shit up end user's console */
    debug(message: string): void {
        if (this.enableDebug) {
            this.log(`[###] ${message}`)
        }
    }

    /* update the disabled status of the export button... prevent exporting when there's nothin to export */
    private updateExportButton(): void {
        this.settings.ExportDataButton.disabled = Boolean(!this.data.datapoints.length)
    }






    /* DATAPOINTS & STORAGE */


    /* start a fresh new datapoint for usage */
    private openDatapoint(skillID: number): void {
        // radiohead - amnesiac
        if (!this.player) {
            throw("no player, can't open datapoint")
        }
        // haven't targeted anything somehow
        if (!this.lastTarget) {
            throw("trying to open new datapoint, but no last target! wtf are we doing rn")
        }
        this.debug("new datapoint initialised :)")
        this.datapoint = {
            startTime: this.getTimeNow(),
            skillID: skillID,
            skillLevel: this.player.skills.get(skillID)!,
            loadout: this.player.loadout,
            target: this.lastTarget,
            itemsReceived: [],
        }
    }


    /* save to internal storage */
    private saveAndCloseDatapoint(): void {
        // nothin to save
        if (!this.datapoint) {
            this.debug("tried to save null datapoint, ignoring")
            return
        }

        const countCollected = this.datapoint.itemsReceived.length

        // got stuff, save it
        if (countCollected) {
            this.debug(`CLOSING datapoint :) we collected ${countCollected} items`)

            // convert to nicer format for reading with human eyes
            const newDatapoint: StoredDatapoint = {
                skillName: this.gameLookups.Skills[this.datapoint.skillID],
                skillLevel: this.datapoint.skillLevel,
                loadout: this.convertLoadoutToNames(this.datapoint.loadout),
                target: this.datapoint.target,
                itemsReceived: this.collapseItemTimestampsToDurations(
                    this.datapoint.startTime, this.datapoint.itemsReceived
                ),
            }

            // find the first stored datapoint that has the exact same header data as us (if any)
            this.debug("searching stored datapoints for a matching header...")
            const matchingIndex: number = this.data.datapoints.findIndex(
                // do a quick and dirty comparison. technically not great but it works for me so it's probably fine
                (storedDatapoint: StoredDatapoint) => (
                    storedDatapoint.skillName === newDatapoint.skillName  // string: ez
                    && storedDatapoint.skillLevel === newDatapoint.skillLevel  // int: ez
                    && JSON.stringify(storedDatapoint.loadout) === JSON.stringify(newDatapoint.loadout)  // array: should always be in the same order so it's fine
                    && JSON.stringify(storedDatapoint.target) === JSON.stringify(newDatapoint.target)  // object: this is less gucci but should be fine... most of the time...
                )
            )

            // match found, we'll piss our itemsReceived data in there please
            if (matchingIndex >= 0) {
                this.debug("matching header found! adding our items now :)")
                let updatedItems: StoredItemDict = this.data.datapoints.at(matchingIndex).itemsReceived

                // add each new item
                Object.keys(newDatapoint.itemsReceived).forEach(
                    (itemName: string) => {
                        // new kind of item
                        if (!(itemName in updatedItems)) {
                            updatedItems[itemName] = []
                        }
                        // add all the collection data
                        newDatapoint.itemsReceived[itemName].forEach(
                            (item: StoredItem) => {
                                updatedItems[itemName].push(item)
                            }
                        )
                    }
                )

                // drop it back in storage and we're all good
                this.data.datapoints[matchingIndex].itemsReceived = updatedItems
            }

            // this new fella is actually unique, slap it on the pile normally
            else {
                this.debug("nope, this is a new one. adding straight on there.")
                this.data.datapoints.push(newDatapoint)
            }

        }

        // nothing collected...
        else {
            this.debug("no items collected, ignoring datapoint")
        }

        // always wipe, prevent stale data
        this.debug("datapoint closed :)")
        this.datapoint = null
        this.lastItem = null
        // don't wipe lastTarget tho, we may have just levelled up and will still be targeting the same entity
        this.updateExportButton()
    }


    /* export data as json to txt file */
    private exportStoredData(): void {
        const numDatapoints = this.data.datapoints.length
        if (!numDatapoints) {
            throw("tried to export zero datapoints. export button is not being disabled correctly!")
        }
        this.debug(`exporting ${numDatapoints} datapoints`)
        // concat each datapoint as json strings
        const prettyPrint = this.settings.PrettyPrintExportCheckbox.value ? 2 : undefined  // activate pretty print if checkbox ticked. doubles file size!! :(
        let outputData = ""
        this.data.datapoints.forEach(
            (datapoint: StoredDatapoint) => {
                outputData += JSON.stringify(datapoint, null, prettyPrint)
                outputData += "\n"
            }
        )
        // save to file
        const filename = `Highspell Data ${this.getDateTimeNow()}.txt`  // technically json but everyone loves .txt
        this.downloadTextAsFile(filename, outputData)
    }


    /* wipe internal storage */
    private clearStoredData(): void {
        if (confirm("clear all stored data? pls export before you do this king")) {
            this.debug("wiping stored data")
            this.data.datapoints = []
            this.updateExportButton()
        }
    }






    /* CLOSERS */


    /* return current equipment as item names */
    private convertLoadoutToNames(loadout: number[]): string[] {
        if (!loadout.length) {
            return []  // your naked ? 😳
        }
        let loadoutNames: string[] = []
        loadout.forEach(
            (itemID) => {
                loadoutNames.push(this.getItemNameFromItemID(itemID))
            }
        )
        return loadoutNames
    }


    /* convert our list of timestamps into a duration to collect each item */
    private collapseItemTimestampsToDurations(startTime: number, itemsReceived: OpenItem[]): StoredItemDict {
        let output: StoredItemDict = {}
        let lastTimestamp = startTime  // to start us off
        itemsReceived.forEach(
            (item) => {
                const itemName = this.getItemNameFromItemID(item.itemId)
                const thisTimestamp = item.timestamp
                const timeToCollect = thisTimestamp - lastTimestamp

                let storedItem: StoredItem = {
                    time: timeToCollect,
                    quantity: item.quantity,
                    isIOU: item.isIOU,
                }

                // first time we've seen this item
                if (!output[itemName]) {
                    output[itemName] = []
                }
                // add to this item's list of collection times
                output[itemName].push(storedItem)

                lastTimestamp = thisTimestamp  // roll along for the next one
            }
        )
        return output
    }






    /* UTILITIES */


    /* alias for unix time now cause i always 4get it */
    private getTimeNow(): number {
        return Math.floor(Date.now())
    }


    /* return datetime now in format 'YYYY-MM-DD hh-mm-ss' */
    private getDateTimeNow(): string {
        return (new Date()).toISOString().replaceAll(':','-').replace('T',' ').split('.')[0]
    }


    /* return item name for given item id */
    private getItemNameFromItemID(itemID: number): string {
        return this.gameHooks.ItemDefinitionManager._itemDefMap.get(itemID)._nameCapitalized
    }


    /* return target name from an ID and type */
    private getTarget(targetID: number, targetType: targetType): Target {
        let id: number
        let name: string
        // world entity table (fishing, mining, choppin trees...)
        if (targetType === "Environment") {
            const def = this.gameHooks.WorldEntityManager._worldEntityManager._worldEntities.get(targetID)._def
            id = def._id
            name = def._name
        }
        // npc entity table (pickpocketing)
        else if (targetType === "NPC") {
            const def = this.gameHooks.NpcDefinitionManager._npcDefMap.get(targetID)
            id = def._id
            name = def._name
        }
        // player lookup. happens when trading/following, but there's no skilling related to players (Yet™)
        else if (targetType === "Player") {
            const def = this.gameHooks.EntityManager.Instance._players.find(
                player => (player._entityId === targetID)
            )
            id = targetID  // this is only a session id, but not sure what else we could put here
            name = def._name
        }
        // something else?
        else {
            throw(`can't get entity for target with id: ${targetID}, type: ${targetType}`)
        }
        return {
            id: id,
            name: name
        }
    }


    /* save text as a file to user's computer. stolen from https://www.geeksforgeeks.org/javascript/javascript-program-to-write-data-in-a-text-file/ */
    private downloadTextAsFile(filename: string, text: string): void {
        const blob = new Blob([text], { type: 'text/plain' })
        const link = document.createElement('a')
        link.href = URL.createObjectURL(blob)
        link.download = filename  // please don't make this an invalid filename or bill gates will cry and cry
        link.click()
    }






    /* GAME HOOKS */


    /* start skilling: start collecting data */
    SocketManager_handleStartedSkillingPacket(packet: number[]): void {
        const playerID = packet[0]
        // const targetID = packet[1]
        const skillID = packet[2]
        // const targetType = packet[3]

        // radiohead - amnesiac
        if (!this.player) {
            throw("no player, can't start skilling")
        }
        // not about us, ignore.
        if (playerID != this.player.id) {
            return
        }
        // already have an open datapoint??
        if (this.datapoint != null) {
            throw("started skilling with an open datapoint!!! why wasn't the last one closed....")
        }

        const skillName = this.gameLookups['Skills'][skillID]
        this.debug(`start skilling: ${skillName}`)

        this.openDatapoint(skillID)
    }


    /* stop skilling: close datapoint */
    SocketManager_handleStoppedSkillingPacket(packet: number[]): void {
        const playerID = packet[0]
        const skillID = packet[1]
        // const didExhaustResources = packet[2]

        // radiohead - amnesiac
        if (!this.player) {
            throw("no player, can't stop skilling")
        }
        // not about us, ignore
        if (playerID != this.player.id) {
            return
        }
        // idk how this could happen
        if (!this.datapoint) {
            throw("stopped skilling, but no active datapoint. ignoring.")
        }

        const skillName = this.gameLookups['Skills'][skillID]
        this.debug(`stop skilling: ${skillName}`)

        this.saveAndCloseDatapoint()
    }


    /* start targeting something: remember our last target */
    SocketManager_handleStartedTargetingPacket(packet:number[]): void {
        const entityID = packet[0]  // entity doing the targeting
        const targetID = packet[2]  // the target itself
        const targetType = packet[3]  // defines which lookup table we should use to find the generic data for this guy

        // radiohead - amnesiac
        if (!this.player) {
            throw("no player, can't start targeting")
        }
        // not about us, ignore
        if (entityID != this.player.id) {
            return
        }

        this.lastTarget = this.getTarget(
            targetID,
            this.gameLookups.EntityTypes[targetType]  // compare with string for easier code reading
        )
        this.debug(`now targeting entity id ${this.lastTarget.id} (${this.lastTarget.name})`)
    }

    /*

    problem!

    when we receive an item from skilling, we hear two packets:
        - handleAddedItemAtInventorySlotPacket
            - comes first, defines a bunch of details of the received item
        - obtainedResourcePacket
            - comes second, defines only the ID of the received item

    the first one procs for ALL items collected, including shit we pick up off the ground while skilling (which should not be logged)
        - only listening to this can easily add unrelated junk data
    the second one only procs on receiving a skilling resource, but contains no info about the item itself
        - only listening to this will exclude a lot of useful info (quantity, IOU, etc) that we should really collect

    solution: listen to BOTH
        - when we hear first packet, store that item in a temporary buffer (this.lastItem)
        - when we hear second packet, check that the ID matches our buffered item before adding it

    this filters out ground items and makes sure we ONLY log resources obtained from skilling

    */


    /* obtained skilling resource: first packet, store item in buffer*/
    SocketManager_handleAddedItemAtInventorySlotPacket(packet: number[]): void {
        // not currently logging, idc
        if (!this.datapoint) {
            this.debug("handleAddedItemAtInventorySlotPacket with no active datapoint, ignoring")
            return
        }

        const menuType = packet[0]
        // const slot = packet[1]
        const itemID = packet[2]
        const quantity = packet[3]
        const isIOU = Boolean(packet[4])  // 0 = false, 1 = true
        // const previousAmountAtSlot = packet[5]

        // wasn't added to our inventory, idc
        if (menuType != 0) {
            this.debug("wrong menu type, ignoring")
            return
        }

        // update the last item we heard get slipped into our inventory
        this.lastItem = {
            menuType: menuType,
            itemID: itemID,
            quantity: quantity,
            isIOU: isIOU,
            timestamp: this.getTimeNow()
        }

        this.debug(`last item updated: ${this.lastItem.quantity}x ${this.getItemNameFromItemID(this.lastItem.itemID)}`)
    }


    /* obtained skilling resource: second packet, compare with stored buffer item */
    SocketManager_handleObtainedResourcePacket(packet: number[]): void {
        const itemID = packet[0]  // the sole contents of this packet

        // not currently logging, idc
        if (!this.datapoint) {
            this.debug("handleObtainedResourcePacket with no active datapoint, ignoring")
            return
        }
        // no last item logged... why...
        if (!this.lastItem) {
            throw("obtained a resource, but no lastItem... what??")
        }
        // last item is not what we obtained just now, so we have no details to log
        if (this.lastItem.itemID != itemID) {
            throw("last item has diff ID than what we just got from obtainedResourcePacket... wtf...")
        }
        // last item is from more than 1 tick ago, so can't be related to the item we just received.... right? this has never actually proc'd so \o/
        const age = this.getTimeNow() - this.lastItem.timestamp
        if (age > 600) {
            this.debug("lastItem is more than 600ms older than obtainedResourcePacket... assuming not related? ignoring.")
            return
        }
        // radiohead - amnesiac
        if (!this.player) {
            throw("no player, can't obtain this precious resource")
        }

        // ok i'm pretty confident this is now an item we received from skilling and should be logged
        this.debug(`new skilling item: ${this.lastItem.quantity}x ${this.getItemNameFromItemID(itemID)}`)

        // timestamp this item and slap it on the pile
        const itemReceived: OpenItem = {
            itemId: itemID,
            quantity: this.lastItem.quantity,
            timestamp: this.getTimeNow(),
            isIOU: this.lastItem.isIOU,
        }
        this.datapoint.itemsReceived.push(itemReceived)

        this.lastItem = null  // reset to be safe

        // if player levelled up from collecting this item, then we need a new datapoint
        const previousSkillLevel = this.datapoint.skillLevel
        const currentSkillLevel = this.player.skills.get(this.datapoint.skillID)
        if (previousSkillLevel != currentSkillLevel) {
            this.debug("player levelled up, refreshing datapoint")
            const skillID = this.datapoint.skillID  // save before destruction
            this.saveAndCloseDatapoint()
            this.openDatapoint(skillID)  // reopen with same skill
        }

        // if user changes their loadout, they automatically stop skilling... right?
        // not always, like with equipping arrows... but that's combat, not skilling... idk....
        // might need to force a close on loadout change regardless just to be safe
        // should do that in a separate function, hook _handleUnequippedItemPacket: [userID, itemID]

    }

}
