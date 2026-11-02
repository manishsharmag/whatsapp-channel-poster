package com.hssc.poster

import android.content.Context

/** The few app-wide choices the phone has to remember between launches. */
object Prefs {
    private const val FILE = "poster"

    private fun sp(context: Context) = context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    /** Start the poster by itself after the phone reboots. On unless switched off. */
    fun autoStart(context: Context): Boolean = sp(context).getBoolean("autoStart", true)

    fun setAutoStart(context: Context, value: Boolean) {
        sp(context).edit().putBoolean("autoStart", value).apply()
    }

    /** The "allow background" question is asked once, not on every launch. */
    fun askedBackground(context: Context): Boolean = sp(context).getBoolean("askedBackground", false)

    fun markAskedBackground(context: Context) {
        sp(context).edit().putBoolean("askedBackground", true).apply()
    }
}
