/**
 * A product taxonomy of about 200 nodes, written as an indented outline (two spaces per level) and parsed into a tree.
 * The root ("Products") is not part of a node's path: the path of the drills category is `Tools > Power Tools > Drills`.
 * Some leaves are deliberate distractors (drill bits under Accessories, hand drills under Hand Tools, garden power tools).
 */
const OUTLINE = `
Tools
  Power Tools
    Drills
    Saws
    Sanders
    Routers
    Grinders
    Impact Drivers
  Hand Tools
    Hammers
    Screwdrivers
    Wrenches
    Pliers
    Hand Drills and Braces
    Saws and Chisels
  Tool Accessories
    Drill Bits
    Saw Blades
    Sanding Discs
    Tool Batteries and Chargers
  Tool Storage
    Toolboxes
    Workbenches
    Tool Belts
  Measuring and Layout
    Tape Measures
    Spirit Levels
    Laser Measures
Garden and Outdoor
  Garden Power Tools
    Lawn Mowers
    Hedge Trimmers
    String Trimmers
    Leaf Blowers
    Chainsaws
  Garden Hand Tools
    Spades and Shovels
    Rakes
    Pruners
    Hoses and Watering
  Plants and Seeds
    Flower Seeds
    Vegetable Seeds
    Houseplants
    Bulbs
  Outdoor Living
    Patio Furniture
    Barbecues and Grills
    Parasols
    Hammocks
Kitchen and Dining
  Cookware
    Pots and Pans
    Baking Trays
    Pressure Cookers
  Small Appliances
    Blenders
    Toasters
    Coffee Machines
    Kettles
    Food Processors
  Cutlery and Knives
    Kitchen Knives
    Cutlery Sets
  Tableware
    Plates and Bowls
    Glasses
    Mugs
  Food Storage
    Lunch Boxes
    Jars and Canisters
Electronics
  Computers
    Laptops
    Desktops
    Monitors
    Keyboards and Mice
  Phones and Tablets
    Smartphones
    Tablets
    Phone Cases
    Chargers and Cables
  Audio
    Headphones
    Speakers
    Microphones
  Cameras
    Digital Cameras
    Action Cameras
    Camera Lenses
    Tripods
  TV and Home Cinema
    Televisions
    Projectors
    Soundbars
  Smart Home
    Smart Speakers
    Smart Lighting
    Security Cameras
    Thermostats
Home and Furniture
  Living Room
    Sofas
    Coffee Tables
    Bookcases
    Armchairs
  Bedroom
    Beds
    Mattresses
    Wardrobes
    Bedside Tables
  Home Office Furniture
    Desks
    Office Chairs
    Filing Cabinets
  Lighting
    Ceiling Lights
    Table Lamps
    Floor Lamps
    Light Bulbs
  Bedding and Bath
    Duvets
    Pillows
    Towels
Clothing
  Men
    Men's Shirts
    Men's Trousers
    Men's Jackets
    Men's Shoes
  Women
    Women's Dresses
    Women's Tops
    Women's Jackets
    Women's Shoes
  Children
    Baby Clothes
    Boys' Clothes
    Girls' Clothes
  Accessories
    Belts
    Hats
    Scarves
    Bags
Sports and Fitness
  Cycling
    Bicycles
    Helmets
    Bike Lights
  Fitness Equipment
    Dumbbells
    Yoga Mats
    Treadmills
    Resistance Bands
  Team Sports
    Footballs
    Basketballs
    Tennis Rackets
  Camping and Hiking
    Tents
    Sleeping Bags
    Backpacks
    Hiking Boots
  Water Sports
    Swimwear
    Snorkels
    Kayaks
Toys and Games
  Building Toys
    Building Blocks
    Model Kits
  Board Games
    Strategy Games
    Family Games
    Puzzles
  Dolls and Plush
    Dolls
    Soft Toys
  Outdoor Toys
    Scooters
    Trampolines
    Sandpits
  Electronic Toys
    Remote Control Cars
    Drones
Office and School
  Stationery
    Pens and Pencils
    Notebooks
    Staplers
  Paper Products
    Printer Paper
    Envelopes
    Sticky Notes
  Printers and Ink
    Laser Printers
    Inkjet Printers
    Ink Cartridges
  Art Supplies
    Paints
    Brushes
    Sketchbooks
Pet Supplies
  Dog
    Dog Food
    Dog Toys
    Dog Beds
    Leashes
  Cat
    Cat Food
    Cat Litter
    Scratching Posts
  Fish and Aquarium
    Aquariums
    Fish Food
  Small Animals
    Hamster Cages
    Rabbit Hutches
Automotive
  Car Parts
    Brake Pads
    Spark Plugs
    Wiper Blades
    Car Batteries
  Car Care
    Car Wax
    Car Wash Kits
    Air Fresheners
  Car Electronics
    Dash Cameras
    Car Chargers
    GPS Navigators
  Tyres and Wheels
    Summer Tyres
    Winter Tyres
    Wheel Trims
Health and Beauty
  Skin Care
    Moisturisers
    Sunscreen
    Face Masks
  Hair Care
    Shampoo
    Hair Dryers
    Hair Straighteners
  Personal Care
    Electric Toothbrushes
    Razors
    Deodorants
  Vitamins and Supplements
    Multivitamins
    Protein Powder
Books and Media
  Books
    Fiction
    Cookbooks
    Children's Books
    Textbooks
  Music
    Vinyl Records
    CDs
  Films
    Blu-ray Discs
    DVDs
`;

export type TaxonomyNode = { name: string; path: string[]; children: TaxonomyNode[]; parent?: TaxonomyNode };

export const ROOT_NAME = "Products";

export function parseTaxonomy(outline: string = OUTLINE): TaxonomyNode {
  const root: TaxonomyNode = { name: ROOT_NAME, path: [], children: [] };
  const stack: TaxonomyNode[] = [root];
  for (const line of outline.split("\n")) {
    if (!line.trim()) continue;
    const depth = (line.length - line.trimStart().length) / 2 + 1;
    const parent = stack[depth - 1]!;
    const name = line.trim();
    const node: TaxonomyNode = { name, path: [...parent.path, name], children: [], parent };
    parent.children.push(node);
    stack.length = depth;
    stack[depth] = node;
  }
  return root;
}

export function countNodes(node: TaxonomyNode): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
}

export const formatPath = (path: readonly string[]) => (path.length === 0 ? ROOT_NAME : path.join(" > "));
