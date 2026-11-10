package com.example.inventory;

public class InventoryApp {
    public static void main(String[] args) {
        Inventory inv = new Inventory();
        inv.add("HAM-01", Inventory.Category.TOOLS, 12);
        inv.add("BOLT-M6", Inventory.Category.PARTS, 400);
        inv.add("TAPE-50", Inventory.Category.SUPPLIES, 35);
        System.out.println("Parts on shelf " + Inventory.shelf(Inventory.Category.PARTS) + ": "
                + inv.total(Inventory.Category.PARTS) + " " + Inventory.UNIT);
    }
}
