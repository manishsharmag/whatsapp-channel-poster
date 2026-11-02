package com.hssc.poster

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Brings the poster back after a reboot (or after the app is updated).
 *
 * A phone that restarted overnight would otherwise sit idle until somebody
 * opened the app, and the 08:00 run would be missed. Only the foreground
 * service is started here — the panel itself stays closed, which is fine: the
 * schedule and the forwarder run inside Node.
 */
class BootReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        val wanted = action == Intent.ACTION_BOOT_COMPLETED
            || action == Intent.ACTION_MY_PACKAGE_REPLACED
            || action == "android.intent.action.QUICKBOOT_POWERON"
        if (!wanted) return
        if (!Prefs.autoStart(context)) return

        // Starting a foreground service from the background is allowed after a
        // boot, but an OEM build may still refuse; never crash the receiver.
        try {
            NodeService.start(context)
        } catch (_: Exception) {
            // The user can always open the app by hand.
        }
    }
}
